import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {supabase} from './supabase'
import './style.css'

function App(){
  if(!supabase) return <main className="shell"><section className="card auth"><div className="brand">U<span>S</span></div><h1>UniShuffle</h1><p className="tag">Supabase configuration is missing.</p><div className="msg">VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is not available in this deployment.</div></section></main>
  const [session,setSession]=useState(null), [email,setEmail]=useState(''), [otp,setOtp]=useState('')
  const [step,setStep]=useState('email'), [loading,setLoading]=useState(false), [msg,setMsg]=useState('')
  const [profile,setProfile]=useState(null), [form,setForm]=useState({nickname:'',college:'',year:'',department:'',interests:'',bio:''})

  useEffect(()=>{supabase.auth.getSession().then(({data})=>setSession(data.session)); const {data}=supabase.auth.onAuthStateChange((_e,s)=>setSession(s)); return()=>data.subscription.unsubscribe()},[])
  useEffect(()=>{if(session) loadProfile()},[session])

  async function loadProfile(){
    const {data}=await supabase.from('profiles').select('*').eq('id',session.user.id).maybeSingle()
    setProfile(data)
    if(data) setForm({nickname:data.nickname||'',college:data.college||'',year:data.year||'',department:data.department||'',interests:(data.interests||[]).join(', '),bio:data.bio||''})
  }
  async function sendOtp(e){e.preventDefault();setLoading(true);setMsg('')
    const {error}=await supabase.auth.signInWithOtp({email:email.trim()})
    setLoading(false); if(error)setMsg(error.message); else {setStep('otp');setMsg('OTP sent. Check your email.')}
  }
  async function verify(e){e.preventDefault();setLoading(true);setMsg('')
    const {error}=await supabase.auth.verifyOtp({email:email.trim(),token:otp.trim(),type:'email'})
    setLoading(false); if(error)setMsg(error.message); else setMsg('Verified!')
  }
  async function saveProfile(e){e.preventDefault();setLoading(true);setMsg('')
    const interests=form.interests.split(',').map(x=>x.trim()).filter(Boolean)
    const payload={id:session.user.id,nickname:form.nickname.trim(),college:form.college.trim()||null,year:form.year.trim()||null,department:form.department.trim()||null,interests,bio:form.bio.trim()||null}
    const {error}=await supabase.from('profiles').upsert(payload)
    setLoading(false); if(error)setMsg(error.message); else {setMsg('Profile saved!');loadProfile()}
  }
  async function signout(){await supabase.auth.signOut();setProfile(null);setStep('email')}
  if(!session) return <main className="shell"><section className="card auth"><div className="brand">U<span>S</span></div><h1>UniShuffle</h1><p className="tag">Meet someone new from your college.</p>
    {step==='email'?<form onSubmit={sendOtp}><label>Email address</label><input type="email" required placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)}/><button disabled={loading}>{loading?'Sending…':'Send OTP'}</button></form>
    :<form onSubmit={verify}><label>6-digit OTP</label><input inputMode="numeric" maxLength="6" required placeholder="123456" value={otp} onChange={e=>setOtp(e.target.value.replace(/\D/g,''))}/><button disabled={loading}>{loading?'Verifying…':'Verify OTP'}</button><button type="button" className="ghost" onClick={()=>setStep('email')}>Change email</button></form>}
    {msg&&<div className="msg">{msg}</div>}<small>Your email is used only for authentication.</small></section></main>
  return <main className="shell"><nav><div className="navbrand">UniShuffle</div><button className="ghost small" onClick={signout}>Log out</button></nav>
    <section className="card profile"><div className="hero"><div className="avatar">{(form.nickname||'U')[0].toUpperCase()}</div><div><h2>{profile?'Welcome back':'Create your profile'}</h2><p>Tell people a little about you.</p></div></div>
    <form onSubmit={saveProfile}><div className="grid"><div><label>Nickname *</label><input required minLength="2" maxLength="24" value={form.nickname} onChange={e=>setForm({...form,nickname:e.target.value})}/></div><div><label>College</label><input value={form.college} onChange={e=>setForm({...form,college:e.target.value})}/></div><div><label>Year</label><input placeholder="1st Year" value={form.year} onChange={e=>setForm({...form,year:e.target.value})}/></div><div><label>Department</label><input placeholder="CSE" value={form.department} onChange={e=>setForm({...form,department:e.target.value})}/></div></div><label>Interests <span>(comma separated)</span></label><input placeholder="Music, coding, movies" value={form.interests} onChange={e=>setForm({...form,interests:e.target.value})}/><label>Bio</label><textarea maxLength="160" placeholder="Something about you…" value={form.bio} onChange={e=>setForm({...form,bio:e.target.value})}/><button disabled={loading}>{loading?'Saving…':'Save Profile'}</button></form>
    {msg&&<div className="msg">{msg}</div>}<div className="coming"><b>Next:</b> matching, live chat, skip, block & report are ready to connect to the existing UniShuffle database.</div></section></main>
}
createRoot(document.getElementById('root')).render(<App />)