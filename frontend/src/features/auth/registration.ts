/** Public configuration only. Provider credentials never belong in VITE_* variables. */
export function publicDialNumber(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^\+[1-9][\d ()-]*$/.test(raw)) return;
  const number=raw.replace(/[ ()-]/g,'');
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : undefined;
}
export function callRegistrationConfig(env: Record<string,unknown>, legalAllowed: boolean) {
  const number=publicDialNumber(env.VITE_IVR_PUBLIC_NUMBER);
  return {number,enabled:legalAllowed&&env.VITE_IVR_REGISTRATION_ENABLED==='true'&&env.VITE_IVR_SIGNIN_READY==='true'&&!!number};
}
