import { SSOAction } from '../../src/@types/auth';
import { TestClient } from '../TestClient';

describe('Login request', function() {
    let client: TestClient;

    beforeEach(function() {
        client = new TestClient();
    });

    afterEach(function() {
        client.stop();
    });

    it('should store "access_token" and "user_id" if in response', async function() {
        const response = { user_id: 1, access_token: Date.now().toString(16) };

        client.httpBackend.when('POST', '/login').respond(200, response);
        client.httpBackend.flush('/login', 1, 100);
        await client.client.login('m.login.any', { user: 'test', password: '12312za' });

        expect(client.client.getAccessToken()).toBe(response.access_token);
        expect(client.client.getUserId()).toBe(response.user_id);
    });
});

describe('SSO login URL', function() {
    let client: TestClient;

    beforeEach(function() {
        client = new TestClient();
    });

    afterEach(function() {
        client.stop();
    });

    describe('SSOAction', function() {
        const redirectUri = "https://test.com/foo";

        it('No action', function() {
            const urlString = client.client.getSsoLoginUrl(redirectUri, undefined, undefined, undefined);
            const url = new URL(urlString);
            expect(url.searchParams.has('org.matrix.msc3824.action')).toBe(false);
        });

        it('register', function() {
            const urlString = client.client.getSsoLoginUrl(redirectUri, undefined, undefined, SSOAction.REGISTER);
            const url = new URL(urlString);
            expect(url.searchParams.get('org.matrix.msc3824.action')).toEqual('register');
        });

        it('login', function() {
            const urlString = client.client.getSsoLoginUrl(redirectUri, undefined, undefined, SSOAction.LOGIN);
            const url = new URL(urlString);
            expect(url.searchParams.get('org.matrix.msc3824.action')).toEqual('login');
        });
    });
});
