import {useRef,useState} from 'react';
import {t} from '../../i18n';
import {callRegistrationConfig} from './registration';
export default function IvrRegistration({legalAllowed,portal,onContinue}:{legalAllowed:boolean;portal:boolean;onContinue:()=>void}) {
 const config=callRegistrationConfig(import.meta.env,legalAllowed);
 const [copyState,setCopyState]=useState<'done'|'manual'|''>('');const input=useRef<HTMLInputElement>(null);
 return <details className="ivr-registration"><summary>{t('ivr.title')}</summary><div className="ivr-content">
 {config.enabled?<><p>{t('ivr.steps')}</p><label>{t('ivr.number')}<input ref={input} readOnly value={config.number} onFocus={e=>e.target.select()}/></label><div className="button-row"><a className="button primary" href={'tel:'+config.number}>{t('ivr.call')}</a><button className="button outline" type="button" onClick={async()=>{try{await navigator.clipboard.writeText(config.number!);setCopyState('done')}catch{setCopyState('manual');input.current?.focus();input.current?.select()}}}>{t('ivr.copy')}</button></div>{copyState&&<p role="status">{t(copyState==='done'?'ivr.copied':'ivr.copyManual')}</p>}<p>{t('ivr.handoff')}</p><p>{t('ivr.after')}</p></>:<><p>{t('ivr.unavailable')}</p><p>{t('ivr.webAlternative')}</p></>}
 <p className="field-hint">{t('ivr.noPassword')}</p>{portal?<a className="text-link" href="/?signin=code">{t('ivr.continue')}</a>:<button className="text-button" type="button" onClick={onContinue}>{t('ivr.continue')}</button>}
 </div></details>;
}
