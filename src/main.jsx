import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { supabase } from './supabase'
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
  const remoteVideo = useRef(null)
  const streamRef = useRef(null)
  const peerRef = useRef(null)
  const channelRef = useRef(null)

  useEffect(() => {
    if (!supabase) { setStatus('Supabase is not configured on this deployment.'); setScreen('error'); return }
    bootstrap()
    return () => cleanupCall()
  }, [])

  async function bootstrap() {
    let { data: { session: current } } = await supabase.auth.getSession()
    if (!current) {
      const { data, error } = await supabase.auth.signInAnonymously()
      if (error) { setStatus(error.message); setScreen('error'); return }
      current = data.session
    }
    setSession(current)
    await loadProfile(current.user.id)
  }

  async function loadProfile(id) {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle()
    if (error) { setStatus(error.message); setScreen('error'); return }
    if (data?.nickname) {
      setProfile(data); setUsername(data.nickname); setGender(data.gender || ''); setScreen('lobby')
    } else setScreen('profile')
  }

  async function saveProfile(e) {
    e.preventDefault()
    if (username.trim().length < 2 || !gender) return
    setLoading(true); setStatus('')
    const { data, error } = await supabase.from('profiles').upsert({ id: session.user.id, nickname: username.trim(), gender }).select().single()
    setLoading(false)
    if (error) { setStatus(error.message); return }
    setProfile(data); setScreen('lobby')
  }

  async function findPartner() {
    setLoading(true); setStatus('Finding another student…')
    const { data, error } = await supabase.rpc('find_match')
    if (error) { setLoading(false); setStatus(error.message); return }
    if (!data) {
      setStatus('You are in the queue. Waiting for another student…')
      setLoading(false)
      setTimeout(findPartner, 2500)
      return
    }
    setMatchId(data); setLoading(false); await openCall(data)
  }

  async function openCall(id) {
    setScreen('call'); setStatus('Connecting…')
    const { data: match, error } = await supabase.from('matches').select('id,user_a,user_b').eq('id', id).single()
    if (error) { setStatus(error.message); return }
    const otherId = match.user_a === session.user.id ? match.user_b : match.user_a
    const { data: p } = await supabase.from('profiles').select('nickname,gender').eq('id', otherId).single()
    setPartner(p || { nickname: 'Student', gender: '' })

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      streamRef.current = stream
      if (localVideo.current) localVideo.current.srcObject = stream
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      peerRef.current = pc
      stream.getTracks().forEach(track => pc.addTrack(track, stream))
      pc.ontrack = e => { if (remoteVideo.current) remoteVideo.current.srcObject = e.streams[0] }
      pc.onicecandidate = e => {
        if (e.candidate && channelRef.current) channelRef.current.send({ type: 'broadcast', event: 'signal', payload: { type: 'candidate', candidate: e.candidate } })
      }

      const channel = supabase.channel('call:' + id)
      channelRef.current = channel
      channel.on('broadcast', { event: 'signal' }, async ({ payload }) => {
        try {
          if (payload.type === 'offer' && !isOfferer(match)) {
            await pc.setRemoteDescription(payload.sdp)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await channel.send({ type: 'broadcast', event: 'signal', payload: { type: 'answer', sdp: answer } })
          } else if (payload.type === 'answer' && isOfferer(match)) {
            await pc.setRemoteDescription(payload.sdp)
          } else if (payload.type === 'candidate' && payload.candidate) {
            await pc.addIceCandidate(payload.candidate)
          }
        } catch (err) { console.error(err) }
      }).subscribe(async s => {
        if (s !== 'SUBSCRIBED') return
        setStatus('Connected — say hello 👋')
        if (isOfferer(match)) {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          await channel.send({ type: 'broadcast', event: 'signal', payload: { type: 'offer', sdp: offer } })
        }
      })
    } catch (err) {
      setStatus('Camera/microphone permission is required for the call.')
    }
  }

  function isOfferer(match) { return match.user_a === session.user.id }

  async function endCall() {
    if (matchId) await supabase.rpc('end_match', { p_match: matchId })
    cleanupCall(); setMatchId(null); setPartner(null); setScreen('lobby'); setStatus('')
  }

  function cleanupCall() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    peerRef.current?.close()
    if (channelRef.current) supabase?.removeChannel(channelRef.current)
    streamRef.current = null; peerRef.current = null; channelRef.current = null
  }

  function toggleMic() {
    const t = streamRef.current?.getAudioTracks()[0]
    if (t) { t.enabled = !t.enabled; setMicOn(t.enabled) }
  }

  function toggleCamera() {
    const t = streamRef.current?.getVideoTracks()[0]
    if (t) { t.enabled = !t.enabled; setCameraOn(t.enabled) }
  }

  if (screen === 'loading') return <main className="shell"><section className="card auth"><div className="brand">US</div><h1>UniShuffle</h1><p>Joining securely…</p></section></main>
  if (screen === 'error') return <main className="shell"><section className="card auth"><div className="brand">US</div><h1>UniShuffle</h1><div className="msg">{status}</div><p>Enable Anonymous Sign-Ins in Supabase → Authentication → Providers, then refresh.</p></section></main>

  if (screen === 'profile') return <main className="shell"><section className="card auth">
    <div className="brand">US</div><h1>UniShuffle</h1><p className="tag">Meet someone new from your college.</p>
    <p className="sub">No email. No OTP. Just choose a username and gender.</p>
    <form onSubmit={saveProfile}>
      <label>Username</label><input required minLength="2" maxLength="24" placeholder="e.g. Lokesh" value={username} onChange={e=>setUsername(e.target.value)}/>
      <label>Gender</label><select required value={gender} onChange={e=>setGender(e.target.value)}><option value="">Choose gender</option><option>Male</option><option>Female</option><option>Other</option></select>
      <button disabled={loading}>{loading ? 'Joining…' : 'Join UniShuffle'}</button>
    </form>
    <small>Your email and phone number are never requested.</small>
  </section></main>

  if (screen === 'lobby') return <main className="shell"><section className="card lobby">
    <div className="brand">US</div><h1>Welcome, {profile?.nickname} 👋</h1>
    <p className="tag">Ready to meet another student?</p>
    <div className="profile-pill"><span>{profile?.nickname}</span><b>{profile?.gender}</b></div>
    <button onClick={findPartner} disabled={loading}>{loading ? 'Finding someone…' : '🎥 Join Random Call'}</button>
    {status && <div className="msg">{status}</div>}
    <div className="features"><span>🎥 Video</span><span>🎙️ Voice</span><span>⏭️ Skip</span><span>🛡️ Report</span></div>
  </section></main>

  return <main className="call-page"><header><b>UniShuffle</b><span>{partner ? 'Talking to ' + partner.nickname : 'Connecting…'}</span></header>
    <div className="videos"><video ref={remoteVideo} autoPlay playsInline className="remote"/><video ref={localVideo} autoPlay muted playsInline className="local"/></div>
    <div className="call-status">{status}</div>
    <div className="controls"><button onClick={toggleMic}>{micOn ? '🎙️' : '🔇'}</button><button onClick={toggleCamera}>{cameraOn ? '📷' : '🚫'}</button><button className="end" onClick={endCall}>End Call</button></div>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
