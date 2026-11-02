import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { supabase } from './supabase'
import DailyIframe from '@daily-co/daily-js'
import './style.css'

function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [username, setUsername] = useState('')
  const [gender, setGender] = useState('')
  const [screen, setScreen] = useState('loading')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [matchId, setMatchId] = useState(null)
  const [partner, setPartner] = useState(null)
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const localVideo = useRef(null)
  const dailyContainerRef = useRef(null)
  const dailyCallRef = useRef(null)
  const pollTimerRef = useRef(null)

  useEffect(() => {
    if (!supabase) {
      setStatus('Supabase configuration is missing. Add the VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY variables in Vercel.')
      setScreen('error')
      return
    }

    bootstrap()
    return () => cleanupCall()
  }, [])

  async function bootstrap() {
    try {
      let { data: { session: current } } = await supabase.auth.getSession()

      if (!current) {
        const { data, error } = await supabase.auth.signInAnonymously()
        if (error) {
          setStatus(error.message)
          setScreen('error')
          return
        }
        current = data.session
      }

      if (!current?.user) {
        setStatus('Could not create a temporary student session. Please refresh and try again.')
        setScreen('error')
        return
      }

      setSession(current)
      await loadProfile(current.user.id)
    } catch (error) {
      setStatus(error?.message || 'Unable to connect to UniShuffle.')
      setScreen('error')
    }
  }

  async function loadProfile(id) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      setStatus(error.message)
      setScreen('error')
      return
    }

    if (data?.nickname) {
      setProfile(data)
      setUsername(data.nickname)
      setGender(data.gender || '')
      setScreen('lobby')
    } else {
      setScreen('profile')
    }
  }

  async function saveProfile(e) {
    e.preventDefault()

    const name = username.trim()
    if (name.length < 2 || !gender || !session?.user?.id) return

    setLoading(true)
    setStatus('')

    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        id: session.user.id,
        nickname: name,
        gender
      })
      .select()
      .single()

    setLoading(false)

    if (error) {
      setStatus(error.message)
      return
    }

    setProfile(data)
    setScreen('lobby')
  }

  async function findPartner() {
    if (!session?.user) return

    setLoading(true)
    setStatus('Finding another student…')

    const { data, error } = await supabase.rpc('find_match')

    if (error) {
      setLoading(false)
      setStatus(error.message)
      return
    }

    if (!data) {
      setStatus('You are in the queue. Waiting for another student…')
      setLoading(false)

      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = setTimeout(findPartner, 2500)
      return
    }

    clearTimeout(pollTimerRef.current)
    setMatchId(data)
    setLoading(false)
    await openCall(data)
  }

  async function openCall(id) {
    setScreen('call')
    setStatus('Preparing your private video room…')

    try {
      const { data: match, error: matchError } = await supabase
        .from('matches')
        .select('id,user_a,user_b')
        .eq('id', id)
        .single()
      if (matchError) throw matchError

      const otherId = match.user_a === session.user.id ? match.user_b : match.user_a
      const { data: p } = await supabase
        .from('profiles')
        .select('nickname,gender')
        .eq('id', otherId)
        .single()
      setPartner(p || { nickname: 'Student', gender: '' })

      const { data: { session: currentSession } } = await supabase.auth.getSession()
      if (!currentSession?.access_token) throw new Error('Your temporary login expired. Please refresh.')

      const response = await fetch('/api/daily-room', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentSession.access_token}`
        },
        body: JSON.stringify({ matchId: id })
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not create the video room.')
      if (!dailyContainerRef.current) throw new Error('Video call area is not ready. Please try again.')

      const callFrame = DailyIframe.createFrame(dailyContainerRef.current, {
        showLeaveButton: false,
        showFullscreenButton: true,
        iframeStyle: { width: '100%', height: '100%', border: '0', borderRadius: '18px' }
      })
      dailyCallRef.current = callFrame
      callFrame.on('joined-meeting', () => setStatus('Connected — say hello 👋'))
      callFrame.on('left-meeting', () => setStatus('Call ended.'))
      callFrame.on('error', event => setStatus(event?.errorMsg || 'Video call connection failed.'))
      await callFrame.join({ url: result.url, token: result.token })
    } catch (error) {
      console.error('Daily call error:', error)
      setStatus(error?.message || 'Unable to start the video call.')
    }
  }

  async function flushCandidates(pc) {
    const candidates = pendingCandidatesRef.current.splice(0)

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate)
      } catch (error) {
        console.error('ICE candidate error:', error)
      }
    }
  }

  function isOfferer(match) {
    return match.user_a === session.user.id
  }

  async function endCall() {
    clearTimeout(pollTimerRef.current)
    try {
      await dailyCallRef.current?.leave()
      await dailyCallRef.current?.destroy()
    } catch (error) {
      console.warn('Daily cleanup:', error)
    }
    dailyCallRef.current = null

    if (matchId) await supabase.rpc('end_match', { p_match: matchId })
    setMatchId(null)
    setPartner(null)
    setScreen('lobby')
    setStatus('')
  }

  function cleanupCall() {
    clearTimeout(pollTimerRef.current)
    if (dailyCallRef.current) {
      dailyCallRef.current.leave().catch(() => {})
      dailyCallRef.current.destroy().catch(() => {})
      dailyCallRef.current = null
    }
  }

  function toggleMic() {
    const track = streamRef.current?.getAudioTracks()[0]
    if (!track) return

    track.enabled = !track.enabled
    setMicOn(track.enabled)
  }

  function toggleCamera() {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return

    track.enabled = !track.enabled
    setCameraOn(track.enabled)
  }

  if (screen === 'loading') {
    return (
      <main className="shell">
        <section className="card auth">
          <div className="brand">US</div>
          <h1>UniShuffle</h1>
          <p>Joining securely…</p>
        </section>
      </main>
    )
  }

  if (screen === 'error') {
    return (
      <main className="shell">
        <section className="card auth">
          <div className="brand">US</div>
          <h1>UniShuffle</h1>
          <div className="msg">{status}</div>
          <button onClick={() => window.location.reload()}>Try Again</button>
        </section>
      </main>
    )
  }

  if (screen === 'profile') {
    return (
      <main className="shell">
        <section className="card auth">
          <div className="brand">US</div>
          <h1>UniShuffle</h1>
          <p className="tag">Meet someone new from your college.</p>
          <p className="sub">No email. No OTP. Just choose a username and gender.</p>

          <form onSubmit={saveProfile}>
            <label>Username</label>
            <input
              required
              minLength="2"
              maxLength="24"
              placeholder="e.g. Lokesh"
              value={username}
              onChange={e => setUsername(e.target.value)}
            />

            <label>Gender</label>
            <select
              required
              value={gender}
              onChange={e => setGender(e.target.value)}
            >
              <option value="">Choose gender</option>
              <option>Male</option>
              <option>Female</option>
              <option>Other</option>
            </select>

            <button disabled={loading}>
              {loading ? 'Joining…' : 'Join UniShuffle'}
            </button>
          </form>

          <small>Your email and phone number are never requested.</small>
        </section>
      </main>
    )
  }

  if (screen === 'lobby') {
    return (
      <main className="shell">
        <section className="card lobby">
          <div className="brand">US</div>
          <h1>Welcome, {profile?.nickname} 👋</h1>
          <p className="tag">Ready to meet another student?</p>

          <div className="profile-pill">
            <span>{profile?.nickname}</span>
            <b>{profile?.gender}</b>
          </div>

          <button onClick={findPartner} disabled={loading}>
            {loading ? 'Finding someone…' : '🎥 Join Random Call'}
          </button>

          {status && <div className="msg">{status}</div>}

          <div className="features">
            <span>🎥 Video</span>
            <span>🎙️ Voice</span>
            <span>⏭️ Skip</span>
            <span>🛡️ Report</span>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="call-page">
      <header>
        <b>UniShuffle</b>
        <span>{partner ? 'Talking to ' + partner.nickname : 'Connecting…'}</span>
      </header>

      <div ref={dailyContainerRef} className="daily-container" />
      <div className="call-status">{status}</div>

      <div className="controls">
        <button className="end" onClick={endCall}>End Call</button>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
