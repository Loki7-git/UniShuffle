'use client'

import React, { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import DailyIframe from '@daily-co/daily-js'

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
  const [messages, setMessages] = useState([])
  const [messageText, setMessageText] = useState('')
  const [showReport, setShowReport] = useState(false)
  const [reportReason, setReportReason] = useState('Inappropriate behavior')
  const [reportDetails, setReportDetails] = useState('')
  const dailyContainerRef = useRef(null)
  const dailyCallRef = useRef(null)
  const pollTimerRef = useRef(null)
  const chatChannelRef = useRef(null)
  const chatBottomRef = useRef(null)

  useEffect(() => {
    if (!supabase) {
      setStatus('Supabase configuration is missing. Add the NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY variables in Vercel.')
      setScreen('error')
      return
    }
    bootstrap()
    return () => cleanupAll()
  }, [])

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function bootstrap() {
    try {
      let { data: { session: current } } = await supabase.auth.getSession()
      if (!current) {
        const { data, error } = await supabase.auth.signInAnonymously()
        if (error) throw error
        current = data.session
      }
      if (!current?.user) throw new Error('Could not create a temporary student session. Please refresh.')
      setSession(current)
      await loadProfile(current.user.id)
    } catch (error) {
      setStatus(error?.message || 'Unable to connect to UniShuffle.')
      setScreen('error')
    }
  }

  async function loadProfile(id) {
    const { data, error } = await supabase.from('profiles').select('id,nickname,gender').eq('id', id).maybeSingle()
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
    const { error } = await supabase.rpc('save_profile', { p_nickname: name, p_gender: gender })
    if (error) {
      setLoading(false)
      setStatus(error.message)
      return
    }
    const { data, error: profileError } = await supabase.from('profiles').select('id,nickname,gender').eq('id', session.user.id).single()
    setLoading(false)
    if (profileError) {
      setStatus(profileError.message)
      return
    }
    setProfile(data)
    setScreen('lobby')
  }

  async function findPartner() {
    if (!session?.user || loading) return
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
    await openCall(data)
    setLoading(false)
  }

  async function cancelMatchmaking() {
    clearTimeout(pollTimerRef.current)
    await supabase.rpc('leave_queue')
    setLoading(false)
    setStatus('')
  }

  async function openCall(id) {
    setScreen('call')
    setStatus('Preparing your private video room…')
    try {
      const { data: match, error: matchError } = await supabase.from('matches').select('id,user_a,user_b').eq('id', id).single()
      if (matchError) throw matchError
      const otherId = match.user_a === session.user.id ? match.user_b : match.user_a
      const { data: p, error: partnerError } = await supabase.from('profiles').select('nickname,gender').eq('id', otherId).single()
      if (partnerError) throw partnerError
      setPartner(p || { nickname: 'Student', gender: '' })

      const { data: { session: currentSession } } = await supabase.auth.getSession()
      if (!currentSession?.access_token) throw new Error('Your temporary login expired. Please refresh.')

      const response = await fetch('/api/daily-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentSession.access_token}` },
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
      callFrame.on('participant-left', () => setStatus('The other student left. You can skip to another student.'))
      await callFrame.join({ url: result.url, token: result.token })
      await loadMessages(id)
      await subscribeToMessages(id)
    } catch (error) {
      console.error('Daily call error:', error)
      setStatus(error?.message || 'Unable to start the video call.')
    }
  }

  async function loadMessages(id) {
    const { data, error } = await supabase.from('messages').select('id,match_id,sender_id,body,created_at').eq('match_id', id).order('created_at', { ascending: true }).limit(100)
    if (!error) setMessages(data || [])
  }

  async function subscribeToMessages(id) {
    if (chatChannelRef.current) await supabase.removeChannel(chatChannelRef.current)
    const channel = supabase.channel(`match-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `match_id=eq.${id}` }, payload => {
        setMessages(current => current.some(item => item.id === payload.new.id) ? current : [...current, payload.new])
      })
      .subscribe()
    chatChannelRef.current = channel
  }

  async function sendMessage(e) {
    e?.preventDefault()
    const body = messageText.trim()
    if (!body || !matchId) return
    setMessageText('')
    const { data, error } = await supabase.rpc('send_message', { p_match: matchId, p_body: body })
    if (error) {
      setMessageText(body)
      setStatus(error.message)
      return
    }
    if (data) setMessages(current => current.some(item => item.id === data.id) ? current : [...current, data])
  }

  async function skipPartner() {
    if (!matchId) return
    const oldMatch = matchId
    await closeDaily()
    await supabase.rpc('end_match', { p_match: oldMatch })
    setMatchId(null)
    setPartner(null)
    setMessages([])
    setShowReport(false)
    setReportDetails('')
    setScreen('lobby')
    setStatus('Finding another student…')
    setTimeout(findPartner, 50)
  }

  async function blockPartner() {
    if (!partner || !matchId) return
    const oldMatch = matchId
    const { data: match } = await supabase.from('matches').select('user_a,user_b').eq('id', oldMatch).single()
    if (!match) return
    const otherId = match.user_a === session.user.id ? match.user_b : match.user_a
    const { error } = await supabase.rpc('block_user', { p_blocked: otherId })
    if (error) {
      setStatus(error.message)
      return
    }
    await closeDaily()
    setMatchId(null)
    setPartner(null)
    setMessages([])
    setShowReport(false)
    setStatus('Student blocked. Finding someone else…')
    setScreen('lobby')
    setTimeout(findPartner, 50)
  }

  async function reportPartner() {
    if (!partner || !matchId) return
    const { data: match, error: matchError } = await supabase.from('matches').select('user_a,user_b').eq('id', matchId).single()
    if (matchError) {
      setStatus(matchError.message)
      return
    }
    const otherId = match.user_a === session.user.id ? match.user_b : match.user_a
    const { error } = await supabase.rpc('report_user', {
      p_reported: otherId,
      p_match: matchId,
      p_reason: reportReason,
      p_details: reportDetails
    })
    if (error) {
      setStatus(error.message)
      return
    }
    setShowReport(false)
    setReportDetails('')
    setStatus('Report submitted. Thank you.')
  }

  async function endCall() {
    clearTimeout(pollTimerRef.current)
    const oldMatch = matchId
    await closeDaily()
    if (oldMatch) await supabase.rpc('end_match', { p_match: oldMatch })
    setMatchId(null)
    setPartner(null)
    setMessages([])
    setScreen('lobby')
    setStatus('')
  }

  async function closeDaily() {
    if (chatChannelRef.current) {
      await supabase.removeChannel(chatChannelRef.current)
      chatChannelRef.current = null
    }
    try {
      await dailyCallRef.current?.leave()
      await dailyCallRef.current?.destroy()
    } catch {}
    dailyCallRef.current = null
  }

  function cleanupAll() {
    clearTimeout(pollTimerRef.current)
    if (chatChannelRef.current) supabase.removeChannel(chatChannelRef.current)
    if (dailyCallRef.current) {
      dailyCallRef.current.leave().catch(() => {})
      dailyCallRef.current.destroy().catch(() => {})
      dailyCallRef.current = null
    }
  }

  if (screen === 'loading') return <main className="shell"><section className="card auth"><div className="brand">US</div><h1>UniShuffle</h1><p>Joining securely…</p></section></main>

  if (screen === 'error') return <main className="shell"><section className="card auth"><div className="brand">US</div><h1>UniShuffle</h1><div className="msg">{status}</div><button onClick={() => window.location.reload()}>Try Again</button></section></main>

  if (screen === 'profile') return (
    <main className="shell">
      <section className="card auth">
        <div className="brand">US</div>
        <h1>UniShuffle</h1>
        <p className="tag">Meet someone new from your college.</p>
        <p className="sub">No email. No OTP. Just choose a username and gender.</p>
        <form onSubmit={saveProfile}>
          <label>Username</label>
          <input required minLength="2" maxLength="24" placeholder="e.g. Lokesh" value={username} onChange={e => setUsername(e.target.value)} />
          <label>Gender</label>
          <select required value={gender} onChange={e => setGender(e.target.value)}>
            <option value="">Choose gender</option>
            <option>Male</option>
            <option>Female</option>
            <option>Other</option>
          </select>
          <button disabled={loading}>{loading ? 'Joining…' : 'Join UniShuffle'}</button>
        </form>
        <small>Your email and phone number are never requested.</small>
      </section>
    </main>
  )

  if (screen === 'lobby') return (
    <main className="shell">
      <section className="card lobby">
        <div className="brand">US</div>
        <h1>Welcome, {profile?.nickname} 👋</h1>
        <p className="tag">Ready to meet another student?</p>
        <div className="profile-pill"><span>{profile?.nickname}</span><b>{profile?.gender}</b></div>
        <button onClick={findPartner} disabled={loading}>{loading ? 'Finding someone…' : '🎥 Join Random Call'}</button>
        {loading && <button className="ghost" onClick={cancelMatchmaking}>Cancel Search</button>}
        {status && <div className="msg">{status}</div>}
        <div className="features"><span>🎥 Video</span><span>💬 Chat</span><span>⏭️ Skip</span><span>🛡️ Report</span></div>
      </section>
    </main>
  )

  return (
    <main className="call-page">
      <header>
        <div><b>UniShuffle</b><span className="header-partner"> · {partner ? partner.nickname : 'Connecting…'}</span></div>
        <button className="header-skip" onClick={skipPartner}>Skip ⏭️</button>
      </header>

      <div className="call-layout">
        <div className="video-panel">
          <div ref={dailyContainerRef} className="daily-container" />
          <div className="call-status">{status}</div>
          <div className="controls">
            <button className="ghost" onClick={() => setShowReport(true)}>Report</button>
            <button className="danger" onClick={blockPartner}>Block</button>
            <button className="end" onClick={endCall}>End</button>
          </div>
        </div>

        <aside className="chat-panel">
          <div className="chat-title">Chat</div>
          <div className="chat-list">
            {messages.length === 0 && <div className="chat-empty">Say hello 👋</div>}
            {messages.map(message => (
              <div key={message.id} className={message.sender_id === session?.user?.id ? 'bubble mine' : 'bubble'}>
                <span>{message.body}</span>
                <small>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
              </div>
            ))}
            <div ref={chatBottomRef} />
          </div>
          <form className="chat-form" onSubmit={sendMessage}>
            <input maxLength="300" value={messageText} onChange={e => setMessageText(e.target.value)} placeholder="Type a message…" />
            <button disabled={!messageText.trim()}>Send</button>
          </form>
          {showReport && (
            <div className="report-box">
              <select value={reportReason} onChange={e => setReportReason(e.target.value)}>
                <option>Inappropriate behavior</option>
                <option>Harassment</option>
                <option>Spam</option>
                <option>Unsafe content</option>
                <option>Other</option>
              </select>
              <textarea maxLength="500" value={reportDetails} onChange={e => setReportDetails(e.target.value)} placeholder="Optional details…" />
              <button onClick={reportPartner}>Submit Report</button>
              <button className="ghost" onClick={() => setShowReport(false)}>Cancel</button>
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}

export default App
