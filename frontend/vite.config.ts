import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({mode}) => {
  const env=loadEnv(mode,process.cwd(),'');
  return {plugins:[react()],define:{'import.meta.env.VITE_PORTAL':JSON.stringify(mode==='portal' ? 'true' : env.VITE_PORTAL || 'false')},server:{proxy:{'/api':{target:env.API_PROXY_TARGET || 'http://localhost:3000',changeOrigin:true}}},preview:{proxy:{'/api':{target:env.API_PROXY_TARGET || 'http://localhost:3000',changeOrigin:true}}},build:{manifest:true,rollupOptions:{input:{main:'index.html',portal:'portal.html'},output:{manualChunks(id){if(id.includes('commonjsHelpers'))return 'runtime';if(id.includes('openpgp'))return 'encryption';if(id.includes('html5-qrcode'))return 'scanner';}}}}};
});
