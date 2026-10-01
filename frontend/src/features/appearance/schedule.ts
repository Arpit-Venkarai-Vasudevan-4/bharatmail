export const themes=['white','warm','dark'] as const;
export type Theme=typeof themes[number];
export type ThemeWindow={id:string;start:string;end:string;theme:Theme};
export type Appearance={theme:Theme;windows:ThemeWindow[]};
export const preferenceKey='bharatmail.appearance.v1';
export const initialAppearance:Appearance={theme:'warm',windows:[]};
export function minutes(value:string){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))return -1;const [hour,minute]=value.split(':').map(Number);return hour*60+minute}
function segments(window:ThemeWindow){const start=minutes(window.start),end=minutes(window.end);return start<end?[[start,end]]:[[start,1440],[0,end]]}
export function validateAppearance(value:Appearance):'invalid'|'overlap'|null{
 if(!value||!themes.includes(value.theme)||!Array.isArray(value.windows)||value.windows.length>24)return 'invalid';
 const ids=new Set<string>();
 for(const w of value.windows){if(!w||typeof w.id!=='string'||ids.has(w.id)||!themes.includes(w.theme)||minutes(w.start)<0||minutes(w.end)<0||w.start===w.end)return 'invalid';ids.add(w.id)}
 for(let i=0;i<value.windows.length;i++)for(let j=i+1;j<value.windows.length;j++)if(segments(value.windows[i]).some(a=>segments(value.windows[j]).some(b=>Math.max(a[0],b[0])<Math.min(a[1],b[1]))))return 'overlap';
 return null;
}
export function activeAppearance(value:Appearance,date=new Date()){const now=date.getHours()*60+date.getMinutes();const window=value.windows.find(w=>segments(w).some(([start,end])=>now>=start&&now<end));return {theme:window?.theme||value.theme,window}}
export function readAppearance():Appearance{try{const raw=localStorage.getItem(preferenceKey);if(raw){const parsed=JSON.parse(raw);if(!validateAppearance(parsed))return parsed}}catch{/* Safe default if storage is denied or corrupted. */}return initialAppearance}
