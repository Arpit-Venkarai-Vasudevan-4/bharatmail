import test from 'node:test';
import assert from 'node:assert/strict';
import {publicDialNumber,callRegistrationConfig} from '../src/features/auth/registration';
test('Public call configuration rejects injected schemes, pauses, consent digits and invalid numbers',()=>{
 for(const value of ['tel:+14155550123','javascript:alert(1)','+14155550123,1','+14155550123;1','+14155550123?x=1','+014155550123','1234','+1'])assert.equal(publicDialNumber(value),undefined);
 assert.equal(publicDialNumber('+1 (415) 555-0123'),'+14155550123');
 const enabled={VITE_IVR_PUBLIC_NUMBER:'+14155550123',VITE_IVR_REGISTRATION_ENABLED:'true',VITE_IVR_SIGNIN_READY:'true'};
 assert.equal(callRegistrationConfig(enabled,true).enabled,true);assert.equal(callRegistrationConfig(enabled,false).enabled,false);assert.equal(callRegistrationConfig({...enabled,VITE_IVR_SIGNIN_READY:'false'},true).enabled,false);assert.equal(callRegistrationConfig({},true).enabled,false);
});
