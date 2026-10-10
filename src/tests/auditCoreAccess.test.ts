import { wafMiddleware } from '../middleware/wafMiddleware';
import { isAllowedMediaToolOrigin } from '../mediaTool/standaloneAccess';

jest.mock('../routes', () => ({ earlyRouteModules: [], postTamperRouteModules: [], preDocsRouteModules: [], preParserRouteModules: [], preTamperRouteModules: [], routeLimiterModules: [], getModuleScopes: () => [] }));
jest.mock('../security/securityPolicy', () => ({ securityBypassPolicy: { waf: [] } }));
jest.mock('../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));

describe('core request boundaries', () => {
  it.each(['https://attacker.example', 'null', 'http://localhost:4007.attacker.example'])('rejects unlisted standalone browser origin %s', origin => {
    expect(isAllowedMediaToolOrigin(origin, ['http://localhost:4007'])).toBe(false);
  });
  it('retains explicit local browser and command-line access', () => {
    expect(isAllowedMediaToolOrigin('http://localhost:4007', ['http://localhost:4007'])).toBe(true);
    expect(isAllowedMediaToolOrigin(undefined, [])).toBe(true);
    expect(isAllowedMediaToolOrigin('https://chosen.example', ['*'])).toBe(true);
  });
  it('rejects an uninspected deep body even beneath a relaxed field', () => {
    let nested: any = 'plain';
    for (let i = 0; i < 12; i++) nested = { child: nested };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    wafMiddleware({ path: '/api/example', method: 'POST', query: {}, body: { content: nested } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
  it('continues accepting ordinary nested request data', () => {
    const next = jest.fn();
    wafMiddleware({ path: '/api/example', method: 'POST', query: {}, body: { value: { child: 'plain' } } } as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
