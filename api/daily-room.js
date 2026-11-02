import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const dailyApiKey = process.env.DAILY_API_KEY

async function dailyRequest(path, options = {}) {
  const response = await fetch(`https://api.daily.co/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${dailyApiKey}`, 'Content-Type': 'application/json' }
  })
  return { response, data: await response.json().catch(() => ({})) }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!supabaseUrl || !supabaseKey || !dailyApiKey) {
    return res.status(500).json({ error: 'Video calling is not configured. Add the required server environment variables.' })
  }

  const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!accessToken) return res.status(401).json({ error: 'Please sign in again.' })
  const { matchId } = req.body || {}
  if (typeof matchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(matchId)) {
    return res.status(400).json({ error: 'Invalid match.' })
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    })
    const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken)
    if (userError || !user) return res.status(401).json({ error: 'Your session is invalid. Please refresh.' })

    const { data: match, error: matchError } = await supabase
      .from('matches').select('id,user_a,user_b,ended_at').eq('id', matchId).maybeSingle()
    if (matchError || !match || match.ended_at || ![match.user_a, match.user_b].includes(user.id)) {
      return res.status(403).json({ error: 'You are not allowed to join this match.' })
    }

    const roomName = `us-${matchId.replace(/-/g, '')}`
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    let room = await dailyRequest('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: roomName, privacy: 'private',
        properties: { exp: expiresAt, eject_at_room_exp: true, max_participants: 2, enable_chat: true, enable_prejoin_ui: true }
      })
    })
    if (!room.response.ok) room = await dailyRequest(`/rooms/${encodeURIComponent(roomName)}`)
    if (!room.response.ok || !room.data.url) {
      console.error('Daily room error:', room.data)
      return res.status(502).json({ error: 'Could not create the private video room. Please try again.' })
    }

    const token = await dailyRequest('/meeting-tokens', {
      method: 'POST',
      body: JSON.stringify({
        properties: { room_name: roomName, user_id: user.id, user_name: user.user_metadata?.nickname || 'UniShuffle student', exp: expiresAt, eject_at_token_exp: true }
      })
    })
    if (!token.response.ok || !token.data.token) {
      console.error('Daily token error:', token.data)
      return res.status(502).json({ error: 'Could not create a secure video-call token.' })
    }
    return res.status(200).json({ url: room.data.url, token: token.data.token })
  } catch (error) {
    console.error('Daily room handler error:', error)
    return res.status(500).json({ error: 'Unable to prepare the video call right now.' })
  }
}
