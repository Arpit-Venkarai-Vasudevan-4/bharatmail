import {restoreLocale} from './i18n';
import React from 'react';
import {createRoot} from 'react-dom/client';
import AuthScreen from './features/auth/AuthScreen';
import './styles.css';
void restoreLocale();
createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthScreen portal onAuthenticated={()=>{}}/></React.StrictMode>);
