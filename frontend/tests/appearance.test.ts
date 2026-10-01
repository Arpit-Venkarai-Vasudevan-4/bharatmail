import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activeAppearance,validateAppearance,type Appearance} from '../src/features/appearance/schedule';
const preference:Appearance={theme:'white',windows:[{id:'night',start:'22:00',end:'07:00',theme:'dark'},{id:'day',start:'07:00',end:'10:00',theme:'warm'}]};
const at=(hour:number,minute=0)=>activeAppearance(preference,new Date(2026,8,30,hour,minute)).theme;
test('midnight crossing and exclusive boundaries fall back to the default',()=>{assert.equal(validateAppearance(preference),null);assert.equal(at(21,59),'white');assert.equal(at(22),'dark');assert.equal(at(0),'dark');assert.equal(at(6,59),'dark');assert.equal(at(7),'warm');assert.equal(at(10),'white')});
test('ambiguous overlaps including midnight and equal times are rejected',()=>{assert.equal(validateAppearance({...preference,windows:[...preference.windows,{id:'collision',start:'06:00',end:'08:00',theme:'white'}]}),'overlap');assert.equal(validateAppearance({...preference,windows:[{id:'all',start:'00:00',end:'00:00',theme:'white'}]}),'invalid');assert.equal(validateAppearance({...preference,windows:[{id:'bad',start:'24:00',end:'08:00',theme:'white'}]}),'invalid')});
test('corrupt stored preferences do not pass validation',()=>{for(const value of [null,{}, {theme:'dark',windows:[null]}, {theme:'blue',windows:[]}])assert.equal(validateAppearance(value as Appearance),'invalid')});
