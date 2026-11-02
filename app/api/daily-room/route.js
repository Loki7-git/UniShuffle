import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const dailyApiKey = process.env.DAILY_API_KEY

async function dailyRequest(path, options = {}) {
  const response = await fetch(`https://api.daily.co/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${dailyApiKey}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  })
  return { response, data: await response.json().catch(() => ({})) }
}

export async function POST(request) {
  if (!supabaseUrl || !supabaseKey || !dailyApiKey) {
    return Response.json(
      { error: 'Video calling is not configured. Add the Supabase public variables and DAILY_API_KEY in Vercel.' },
      { status: 500 }
    )
  }

  const accessToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!accessToken) return Response.json({ error: 'Please sign in again.' }, { status: 401 })

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const { matchId } = body || {}
  if (typeof matchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(matchId)) {
    return Response.json({ error: 'Invalid match.' }, { status: 400 })
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    })

    const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken)
    if (userError || !user) {
      return Response.json({ error: 'Your session is invalid. Please refresh.' }, { status: 401 })
    }

    const { data: match, error: matchError } = await supabase
      .from('matches')
      .select('id,user_a,user_b,ended_at')
      .eq('id', matchId)
      .maybeSingle()

    if (matchError || !match || match.ended_at || ![match.user_a, match.user_b].includes(user.id)) {
      return Response.json({ error: 'You are not allowed to join this match.' }, { status: 403 })
    }

    const roomName = `us-${matchId.replace(/-/g, '')}`
    const expiresAt = Math.floor(Date.now() / 1000) + 3600

    let room = await dailyRequest('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: roomName,
        privacy: 'private',
        properties: {
          exp: expiresAt,
          eject_at_room_exp: true,
          max_participants: 2,
          enable_chat: true,
          enable_prejoin_ui: true
        }
      })
    })

    // Both participants can request the room simultaneously; reuse it if already created.
    if (!room.response.ok) {
      room = await dailyRequest(`/rooms/${encodeURIComponent(roomName)}`)
    }
    if (!room.response.ok || !room.data.url) {
      console.error('Daily room error:', room.data)
      return Response.json({ error: 'Could not create the private video room. Please try again.' }, { status: 502 })
    }

    const token = await dailyRequest('/meeting-tokens', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          room_name: roomName,
          user_id: user.id,
          user_name: user.user_metadata?.nickname || 'UniShuffle student',
          exp: expiresAt,
          eject_at_token_exp: true
        }
      })
    })

    if (!token.response.ok || !token.data.token) {
      console.error('Daily token error:', token.data)
      return Response.json({ error: 'Could not create a secure video-call token.' }, { status: 502 })
    }

    return Response.json({ url: room.data.url, token: token.data.token }, {
      headers: { 'Cache-Control': 'no-store' }
    })
  } catch (error) {
    console.error('Daily room handler error:', error)
    return Response.json({ error: 'Unable to prepare the video call right now.' }, { status: 500 })
  }
}
