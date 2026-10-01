import {useEffect,useState} from 'react';
import {activeAppearance,preferenceKey,readAppearance,validateAppearance,type Appearance} from './schedule';
export function useAppearance(){
 const [preferences,setPreferences]=useState(readAppearance),[now,setNow]=useState(()=>new Date());
 useEffect(()=>{const wake=()=>setNow(new Date());const storage=(event:StorageEvent)=>{if(event.key===preferenceKey||event.key===null){setPreferences(readAppearance());wake()}};let timer:ReturnType<typeof setTimeout>;const tick=()=>{if(document.visibilityState==='visible')wake();timer=setTimeout(tick,60000-Date.now()%60000+10)};timer=setTimeout(tick,60000-Date.now()%60000+10);document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);window.addEventListener('pageshow',wake);window.addEventListener('storage',storage);return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);window.removeEventListener('pageshow',wake);window.removeEventListener('storage',storage)}},[]);
 const active=activeAppearance(preferences,now);
 useEffect(()=>{document.documentElement.dataset.theme=active.theme},[active.theme]);
 function save(value:Appearance){const error=validateAppearance(value);if(error)return error;try{localStorage.setItem(preferenceKey,JSON.stringify(value));setPreferences(value);setNow(new Date());return null}catch{return 'storage' as const}}
 return {preferences,active,save};
}
