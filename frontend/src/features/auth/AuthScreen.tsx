import {t,formatDateTime,formatNumber,getLocale,subscribeLocale,localizeSystemMessage} from '../../i18n';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { api, portalApi, ApiError } from '../../lib/api';
import LanguageSelector from '../../i18n/LanguageSelector';
import PhoneField from './PhoneField';
import IvrRegistration from './IvrRegistration';
import { TERMS_VERSION, errorText, phoneInputValid, phonePayload, retryAfter, type AuthResult, type Challenge, type OtpCapabilities, type User } from './contracts';
import './auth.css';

function portalRequest<T>(path:string, body:unknown, token?:string):Promise<T> {
  return portalApi<T>(path,{method:'POST',body,referrerPolicy:'no-referrer'},token);
}
function approvedUrl(raw:unknown):string|undefined { if(typeof raw!=='string'||!raw)return; try { const url=new URL(raw,window.location.origin);return url.protocol==='https:'||url.origin===window.location.origin?url.href:undefined; }catch{return;} }

export default function AuthScreen({portal=false,onAuthenticated,initialMode='login'}:{portal?:boolean;onAuthenticated:(user:User)=>void;initialMode?:'login'|'register'}) {
  useSyncExternalStore(subscribeLocale,getLocale,getLocale);
  const [signup,setSignup]=useState(portal||initialMode==='register'),[phone,setPhone]=useState(''),[country,setCountry]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState('');
  const [consent,setConsent]=useState(false),[method,setMethod]=useState<'otp'|'password'>(()=>!portal&&new URLSearchParams(location.search).get('signin')==='code'?'otp':'password'),[caps,setCaps]=useState<OtpCapabilities|null>(null),[capsError,setCapsError]=useState('');
  const [channel,setChannel]=useState<'sms'|'ivr'>('sms'),[challenge,setChallenge]=useState<Challenge|null>(null),[phase,setPhase]=useState<''|'request'|'auth'>(''),[error,setError]=useState(''),[status,setStatus]=useState(''),[blockedUntil,setBlockedUntil]=useState(0),[until,setUntil]=useState(0),[now,setNow]=useState(Date.now()),[registered,setRegistered]=useState(false),[registeredAddress,setRegisteredAddress]=useState(''),[showPassword,setShowPassword]=useState(false);
  const blocked=Math.max(0,Math.ceil((blockedUntil-now)/1000));const busy=phase!=='';const committing=phase==='auth';const cooldown=Math.max(0,Math.ceil((until-now)/1000));
  const portalToken=useRef<string|null>(null); const codeInput=useRef<HTMLInputElement>(null);const generation=useRef(0),request=useRef<AbortController>();
  const termsUrl=approvedUrl(import.meta.env.VITE_TERMS_URL),privacyUrl=approvedUrl(import.meta.env.VITE_PRIVACY_URL);
  const legalConfigured=Boolean(termsUrl&&privacyUrl&&import.meta.env.VITE_TERMS_VERSION===TERMS_VERSION);
  const registrationAllowed=legalConfigured||import.meta.env.DEV;
  const capability=caps?.otpVerification[channel];
  const available=(c?:OtpCapabilities['otpVerification']['sms'])=>!!c?.supported&&(c.configured||Boolean(import.meta.env.DEV&&c.simulated));
  const otpAvailable=available(capability);
  useEffect(()=>{const abort=new AbortController();fetch('/api/otp/capabilities',{signal:abort.signal,credentials:portal?'omit':'same-origin',cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error(t('auth.capabilityFailed'));return r.json() as Promise<OtpCapabilities>}).then(setCaps).catch(e=>{if(!abort.signal.aborted)setCapsError(errorText(e))});return()=>abort.abort()},[portal]);
  useEffect(()=>{const tick=()=>setNow(Date.now());const timer=setInterval(tick,1000);document.addEventListener('visibilitychange',tick);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick)}},[]);
  useEffect(()=>{if(challenge)codeInput.current?.focus()},[challenge]);
  useEffect(()=>()=>{generation.current++;request.current?.abort();if(portalToken.current)void fetch('/api/auth/logout',{method:'POST',credentials:'omit',keepalive:true,headers:{Authorization:`Bearer ${portalToken.current}`}}).catch(()=>undefined)},[]);
  const resetSecrets=()=>{setPassword('');setShowPassword(false);setCode('');setChallenge(null)};
  function resetFlow(){generation.current++;request.current?.abort();setPhase('');resetSecrets();setError('');setStatus('');setUntil(0);setBlockedUntil(0)}
  function choose(next:'otp'|'password'){if(committing)return;resetFlow();setMethod(next)}
  function changePhone(value:string){resetFlow();setPhone(value)}
  function changeCountry(value:string){resetFlow();setCountry(value)}
  function failure(e:unknown){const retry=retryAfter(e);if(retry){setUntil(Date.now()+retry*1000);setBlockedUntil(Date.now()+retry*1000);}setNow(Date.now());if(e instanceof ApiError&&(e.status===429||e.code==='OTP_RATE_LIMITED'))return t('auth.rateLimited');if(e instanceof ApiError&&e.status===401)return t(method==='password'?'auth.passwordInvalid':'auth.otpInvalidAccount');return errorText(e)}
  async function revokePortal(){if(!portalToken.current)return;await portalRequest('/auth/logout',{},portalToken.current);portalToken.current=null;setRegistered(true);setPhone('');setCountry('');setConsent(false);resetSecrets();setUntil(0);setStatus(t('m_2308880f1d48'))}
  async function requestCode(){
    if(!otpAvailable){setError(t('auth.otpUnavailable'));return}
    if(!phoneInputValid(phone,country)){setError(t('m_6dfab019c738'));return}
    const revision=++generation.current;request.current?.abort();const ctrl=new AbortController();request.current=ctrl;setPhase('request');setError('');setStatus('');
    const purpose=signup?'signup':'login';
    try{const body={...phonePayload(phone,country),purpose,channel};const result=portal?await portalApi<Challenge>('/otp/request',{method:'POST',body,signal:ctrl.signal}):await api<Challenge>('/otp/request',{method:'POST',body,auth:false,refresh:false,signal:ctrl.signal});
      if(revision!==generation.current)return;
      if(result.purpose!==purpose||result.channel!==channel)throw new Error(t('auth.challengeMismatch'));
      setChallenge(result);setCode('');const deadline=result.resendAt?Date.parse(result.resendAt):Date.now()+(result.retryAfterSeconds??60)*1000;setUntil(Number.isFinite(deadline)?deadline:Date.now()+60000);setNow(Date.now());setStatus(t(capability?.simulated?'auth.simulatedAccepted':'auth.requestAccepted'));
    }catch(e){if(revision===generation.current)setError(failure(e))}finally{if(revision===generation.current)setPhase('')}
  }
  async function submit(event:FormEvent){event.preventDefault();if(busy||!portalToken.current&&(blocked>0||cooldown>0&&!(method==='otp'&&challenge)))return;setError('');setStatus('');
    if(!portalToken.current){if(!phoneInputValid(phone,country)){setError(t('m_6dfab019c738'));return}if(signup&&(!registrationAllowed||!consent)){setError(t(registrationAllowed?'m_8502437a9455':'m_01fd80f516cb'));return}if(method==='otp'&&!challenge){await requestCode();return}if(signup&&method==='password'&&(password.length<6||new TextEncoder().encode(password).length>72)){setError(t('m_eabcf287240f'));return}if(challenge&&Date.parse(challenge.expiresAt)<=Date.now()){setError(t('otp.expired'));return}}
    const revision=++generation.current;setPhase('auth');
    try{
      if(portalToken.current){await revokePortal();return}
      const path=method==='otp'?`/auth/otp/${signup?'register':'login'}`:`/auth/${signup?'register':'login'}`;
      const identity=challenge?{phone:challenge.phoneE164,...(challenge.country?{country:challenge.country}:{})}:phonePayload(phone,country);
      const body={...identity,...(method==='otp'?{challengeId:challenge!.challengeId,code,purpose:signup?'signup':'login'}:{password}),...(signup?{signupChannel:portal?'portal':'web',language:getLocale(),termsAccepted:consent,termsVersion:TERMS_VERSION}:{})};
      const result=portal?await portalRequest<AuthResult>(path,body):await api<AuthResult>(path,{method:'POST',body,auth:false,refresh:false});
      if(revision!==generation.current)return;
      resetSecrets();if(portal){if(!result.token)throw new Error(t('m_f5d4aca4fea0'));portalToken.current=result.token;setRegisteredAddress(result.user.email);setPhone('');setCountry('');setConsent(false);await revokePortal()}else onAuthenticated(result.user);
    }catch(e){if(revision===generation.current)setError(portalToken.current?t('m_6a4edb96b7af'):failure(e))}finally{if(revision===generation.current)setPhase('')}
  }
  return <main className={`auth-page ${portal?'auth-portal':''}`}>
    <section className="auth-story" aria-label={t("m_3089a190f833")}><a className="auth-brand" href="/" aria-label={t("m_5237d3c9a824")}><span className="brand-seal" aria-hidden="true">✳</span> {t("m_ed572eb0dd7f")}</a><div className="auth-story-copy"><span className="eyebrow">{t("m_2fa5ad0c7895")}</span><h1>{t("m_4004fb1ea294")}<br/>{t("m_d61deef148c8")}<br/><em>{t("m_5a61f6308c4e")}</em></h1><p>{t("m_b9d118683fa4")}<br/>{t("m_53fa83a8b7dd")}</p><div className="auth-line-art" aria-hidden="true"><span/><span/><span/><span/></div></div><p className="auth-story-footer">{t("m_05c17b1a5943")}</p></section>
    <section className="auth-panel"><div className="auth-form-wrap"><LanguageSelector/><div className="auth-mobile-brand"><span className="brand-seal" aria-hidden="true">✳</span> {t("m_ed572eb0dd7f")}</div><span className="eyebrow">{portal?t("m_66e3b4fb48ce"):signup?t("m_7a074559ce6a"):t("m_d599547e30aa")}</span><h2>{registered?t("m_f3289e1349e7"):portal?t("m_f4365fdf0355"):signup?t("m_0fee4c6e23f4"):t("m_acf532b25321")}</h2><p className="auth-intro">{registered?t("m_20f6b8de152d"):portal?t("m_b27c1dff468d"):signup?t("m_4cccbcfc9b91"):t("m_f55b8f353290")}</p>
      {registered?<div><p className="registered-address">{t('auth.createdAddress',{address:registeredAddress})}</p><p>{t(method==='otp'?'auth.portalCode':'auth.portalPassword')}</p><p role="status" className="notice success">{localizeSystemMessage(status)}</p><button className="primary" onClick={()=>{setRegistered(false);setRegisteredAddress('');resetFlow();}}>{t("m_945bc168cf8b")}</button><a className="text-link" href={method==='otp'?'/?signin=code':'/'}>{t("m_b2d25b05be4c")}</a></div>:<form onSubmit={submit} className="auth-form">
        {!portalToken.current&&<div className="auth-choices" role="group" aria-label={t("auth.method")}><button type="button" aria-pressed={method==='password'} disabled={committing} onClick={()=>choose('password')}>{t("auth.passwordChoice")}</button><button type="button" aria-pressed={method==='otp'} disabled={committing} onClick={()=>choose('otp')}>{t("auth.codeChoice")}</button></div>}
        {portalToken.current?<p className="notice">{t("m_219e4a1165b3")}</p>:<>
          <PhoneField phone={phone} country={country} onPhone={changePhone} onCountry={changeCountry} disabled={committing||Boolean(challenge)} describedBy="auth-error" invalid={!!error}/>
          {method==='password'?<label>{t("m_e7cf3ef4f17c")}<input aria-label={t('m_e7cf3ef4f17c')} aria-describedby="auth-password-help auth-error" aria-invalid={!!error} type={showPassword?'text':'password'} autoComplete={signup?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} required disabled={committing}/><button type="button" className="text-button password-reveal" aria-pressed={showPassword} onClick={()=>setShowPassword(v=>!v)}>{t(showPassword?'auth.hidePassword':'auth.showPassword')}</button><small id="auth-password-help">{t(signup?'auth.passwordRules':'auth.passwordHelp')}</small></label>:<><label htmlFor="auth-channel">{t('auth.channel')}</label><select id="auth-channel" value={channel} disabled={committing} onChange={e=>{resetFlow();setChannel(e.target.value as 'sms'|'ivr')}}><option value="sms" disabled={!available(caps?.otpVerification.sms)}>{t('auth.sms')}</option>{available(caps?.otpVerification.ivr)&&<option value="ivr">{t('auth.voice')}</option>}</select>{!otpAvailable&&<p className="notice">{t(capsError?'auth.capabilityFailed':'auth.otpUnavailable')}</p>}{capability?.simulated&&import.meta.env.DEV&&<p className="field-hint">{t('m_44ef8cbb15c4')}</p>}{challenge?<><label htmlFor="auth-code">{t("m_3ee75029c70e")}<input id="auth-code" aria-describedby="auth-error" aria-invalid={!!error} ref={codeInput} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)} maxLength={12} required disabled={busy}/></label><p className="field-hint">{t('auth.expires',{time:formatDateTime(challenge.expiresAt,{hour:'2-digit',minute:'2-digit'})})}</p><div className="form-inline-actions"><button type="button" className="text-button" disabled={busy||cooldown>0} onClick={()=>void requestCode()}>{cooldown>0?t("m_082dca1907be",{value0:cooldown}):t("m_b97457409ab5")}</button><button type="button" className="text-button" disabled={busy} onClick={resetFlow}>{t("m_cf5741b5c8c5")}</button></div>{Date.parse(challenge.expiresAt)<=now&&<p role="status" className="notice">{t('otp.expired')}</p>}</>:null}</>}
          {signup&&<div className="consent-wrap">{!legalConfigured&&<p className="notice warning">{import.meta.env.DEV?t("m_d8ee9c07d6ab"):t("m_f6c1824c25aa")}</p>}<label className="check-line"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} required disabled={!registrationAllowed||busy}/><span>{legalConfigured?<>{t('auth.consent',{version:TERMS_VERSION})} <a href={termsUrl} target="_blank" rel="noopener noreferrer">{t("m_ede548996483")}</a> · <a href={privacyUrl} target="_blank" rel="noopener noreferrer">{t("m_c385c3440806")}</a></>:<>{t('auth.devConsent',{version:TERMS_VERSION})}</>}</span></label></div>}
        </>}
        <div id="auth-error">{error&&<p className="notice error" role="alert">{localizeSystemMessage(error)}</p>}</div>{status&&<p className="notice" role="status">{localizeSystemMessage(status)}</p>}
        {blocked>0&&<p role="status" className="field-hint">{t('auth.wait',{seconds:blocked})}</p>}<button className="primary auth-next" disabled={busy||blocked>0||(!portalToken.current&&((signup&&!registrationAllowed)||(method==='otp'&&!challenge&&!otpAvailable)||(cooldown>0&&!(method==='otp'&&challenge))))}>{busy?t("m_4660a983366f"):portalToken.current?t("m_cdb89bc29abe"):t(method==='password'?(signup?'auth.create':'auth.signIn'):challenge?'auth.verify':'auth.request')}<span aria-hidden="true">→</span></button>
        {!portalToken.current&&<><p className="field-hint">{t(signup?(method==='password'?'auth.signupUnverified':'auth.signupCode'):'auth.accountMethods')}</p>{!portal&&<p className="auth-switch">{signup?t('m_e77fea936d3e'):t('m_135f20d28972')} <button type="button" className="text-button" disabled={committing} onClick={()=>{resetFlow();setSignup(!signup);setConsent(false)}}>{signup?t('m_bfd402b2f6f3'):t('m_61e8d44ad423')}</button></p>}</>}

      </form>}
      {signup&&!registered&&!busy&&!portalToken.current&&<IvrRegistration legalAllowed={registrationAllowed} portal={portal} onContinue={()=>{resetFlow();setSignup(false);setMethod('otp')}}/>}
      <p className="auth-bottom-note">{portal?t("m_75d0ccafb540"):t("m_ba901e4e33e7")}</p>
    </div></section>
  </main>;
}
