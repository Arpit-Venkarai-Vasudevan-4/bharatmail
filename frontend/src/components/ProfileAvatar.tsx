import { useEffect, useState } from 'react';
import { apiResponse } from '../lib/api';
import type { User } from '../features/mail/types';

export function ProfileAvatar({user,large=false}:{user:User;large?:boolean}) {
  const [src,setSrc]=useState('');
  useEffect(()=>{
    const controller=new AbortController(); let objectUrl=''; setSrc('');
    if(user.profilePictureUrl) void apiResponse('/users/'+encodeURIComponent(user.id)+'/profile-picture',{signal:controller.signal})
      .then(response=>response.blob()).then(blob=>{if(!controller.signal.aborted){objectUrl=URL.createObjectURL(blob);setSrc(objectUrl)}}).catch(()=>{});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)};
  },[user.id,user.profilePictureUrl,user.updatedAt]);
  return <span className={`avatar ${large?'large':''}`}>{src?<img src={src} alt=""/>:(user.displayName||'P').slice(0,1).toUpperCase()}</span>;
}
