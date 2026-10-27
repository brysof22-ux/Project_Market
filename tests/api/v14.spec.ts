import {test,expect} from '@playwright/test'
import {canAccessRoute,canPerform,homeRoute} from '../../shared/permissions'
import {validBusinessResponse} from '../../shared/business-response'
test('V1.4 navegación y acciones financieras mantienen autorización por rol',()=>{expect(homeRoute('admin')).toBe('estadisticas');expect(canAccessRoute('admin','dashboard')).toBe(false);for(const action of ['sales.today','cash.history','cash.detail','finance.list','finance.summary']){expect(canPerform('admin','operations',action)).toBe(true);for(const role of ['cashier','supervisor'] as const)expect(canPerform(role,'operations',action)).toBe(false)}})
test('V1.4 respuestas incompletas de estadísticas y caja se rechazan',()=>{for(const action of ['sales.today','cash.history','cash.detail','finance.list','finance.summary']){expect(validBusinessResponse(action,{})).toBe(false);expect(validBusinessResponse(action,{total:0,rows:[]})).toBe(action==='cash.history')}})
