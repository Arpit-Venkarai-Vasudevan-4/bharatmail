import {useState} from 'react';
import {Modal,ErrorNotice,newId} from '../../components/ui';
import {t} from '../../i18n';
import {themes,type Appearance,type Theme,activeAppearance} from './schedule';
export default function AppearancePanel({preferences,active,save,onClose}:{preferences:Appearance;active:ReturnType<typeof activeAppearance>;save:(value:Appearance)=>'invalid'|'overlap'|'storage'|null;onClose:()=>void}){
 const [draft,setDraft]=useState(()=>structuredClone(preferences)),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 function change(value:Appearance){setDraft(value);setSaved(false);setError('')}
 return <Modal title={t('appearance.title')} onClose={onClose}><form className="appearance-form" onSubmit={event=>{event.preventDefault();const problem=save(draft);setError(problem?t(`appearance.${problem}`):'');setSaved(!problem)}}>
 <p>{t('appearance.device')}</p><p>{t('appearance.timezone',{timezone})}</p><p role="status">{t('appearance.active',{theme:t(`appearance.${active.theme}`)})} {active.window?t('appearance.scheduled',{start:active.window.start,end:active.window.end}):t('appearance.defaultActive')}</p>
 <label>{t('appearance.default')}<select aria-label={t('appearance.default')} value={draft.theme} onChange={e=>change({...draft,theme:e.target.value as Theme})}>{themes.map(theme=><option key={theme} value={theme}>{t(`appearance.${theme}`)}</option>)}</select></label>
 <p>{t('appearance.help')}</p>
 {draft.windows.map((window,index)=><fieldset key={window.id}><legend>{t('appearance.window',{number:index+1})}</legend><div className="appearance-window"><label>{t('appearance.start')}<input aria-label={t('appearance.start')} type="time" required value={window.start} onChange={e=>change({...draft,windows:draft.windows.map(w=>w.id===window.id?{...w,start:e.target.value}:w)})}/></label><label>{t('appearance.end')}<input aria-label={t('appearance.end')} type="time" required value={window.end} onChange={e=>change({...draft,windows:draft.windows.map(w=>w.id===window.id?{...w,end:e.target.value}:w)})}/></label><label>{t('appearance.theme')}<select aria-label={t('appearance.theme')} value={window.theme} onChange={e=>change({...draft,windows:draft.windows.map(w=>w.id===window.id?{...w,theme:e.target.value as Theme}:w)})}>{themes.map(theme=><option key={theme} value={theme}>{t(`appearance.${theme}`)}</option>)}</select></label><button type="button" className="button quiet" aria-label={t('appearance.removeWindow',{number:index+1})} onClick={()=>change({...draft,windows:draft.windows.filter(w=>w.id!==window.id)})}>{t('appearance.remove')}</button></div></fieldset>)}
 <button type="button" className="button outline" disabled={draft.windows.length>=24} onClick={()=>change({...draft,windows:[...draft.windows,{id:newId(),start:'22:00',end:'07:00',theme:'dark'}]})}>{t('appearance.add')}</button>
 {error&&<ErrorNotice message={error}/>}<button className="button primary" type="submit">{t('appearance.save')}</button>{saved&&<p role="status">{t('appearance.saved')}</p>}
 </form></Modal>
}
