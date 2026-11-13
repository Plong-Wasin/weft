# Microsoft Entra sign-in

Microsoft sign-in is optional. With the three required settings empty, Weft keeps the existing sign-in methods. This setup is for one company tenant; Weft checks the signed ID token's `tid` claim and identifies an account by the pair `tid` + `oid`. The email address is profile data only and never selects an existing account.

## Register the application

1. In the Microsoft Entra admin center, create an app registration for **Accounts in this organizational directory only (single tenant)**.
2. Add a **Web** redirect URI equal to `{API_PUBLIC_URL}/api/auth/callback/microsoft-entra-id`. For a single-origin deployment use `{WEFT_PUBLIC_URL}/api/auth/callback/microsoft-entra-id`. The hostname must be the public API origin that Better Auth uses; do not register the web app origin.
3. Add the delegated OpenID Connect scopes `openid`, `profile`, and `email`. Weft reads the verified ID token and does not need Microsoft Graph API permissions.
4. Create a client secret and copy its value once. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_TENANT_ID` in `.env` or the deployment's environment. `MICROSOFT_TENANT_ID` is the tenant's Directory (tenant) ID GUID, not the application ID.
5. Optionally set `MICROSOFT_ALLOWED_EMAIL_DOMAINS` to a comma-separated exact-domain list. The allow list applies after Microsoft authenticates the person.
6. Restart the API. Check the sign-in screen in English and Thai and complete the manual checklist below before setting `PASSWORD_SIGN_IN_ENABLED=false`.

The callback uses Better Auth's authorization-code flow with state and PKCE S256. Keep the tenant setting as a GUID for a single-tenant company. Weft does not use Microsoft's `common` or `organizations` authority in this company configuration.

## Existing accounts and joining

Weft never merges an existing account just because Microsoft returns the same email. A person must first authenticate to the existing Weft account and explicitly link Microsoft from that signed-in session; a matching email alone is refused. New Microsoft accounts still pass the instance's open-signup or invite gate. Microsoft sign-in never assigns a workspace role or an admin role.

The sign-in page explains that Microsoft is for company work accounts. A wrong-tenant or disallowed-domain sign-in is refused; if signup is closed, a person needs an invite. Employees should contact their company IT administrator about tenant or domain access and their Weft administrator for an invite.

## Password recovery and access revocation

`PASSWORD_SIGN_IN_ENABLED` defaults to `true`. If password sign-in was switched off and Microsoft sign-in is unavailable, set `PASSWORD_SIGN_IN_ENABLED=true` in the deployment environment and restart the API to restore the password form and endpoints. Keep an administrator-controlled copy of the deployment environment settings.

Signing out clears the Weft session; it does not sign the person out of Microsoft. Weft sessions expire after seven days by default. Disabling a person's account in Entra prevents later Microsoft authentication but does not immediately end an existing Weft session. For urgent revocation, find the corresponding Weft user and delete that user's rows from the `session` table; otherwise the current session ends at sign-out or expiry. Rotating the Microsoft client secret affects later authorization-code exchanges, not sessions already issued by Weft.

Rotate the Entra secret before its expiry: create a replacement secret in Entra, update `MICROSOFT_CLIENT_SECRET`, restart the API, test a fresh sign-in, then remove the old secret in Entra. Never put the secret in a client bundle or commit it.

## Manual verification checklist

Automated tests use a local fake OpenID provider. They do not contact Microsoft, so real-tenant behavior is **unverified** until an operator completes this checklist with the company's tenant:

- [ ] Confirm the application registration is single-tenant and its redirect URI exactly matches the API callback above.
- [ ] Sign in with an employee account and verify a new Weft account is created with the employee's display name and work email.
- [ ] Sign out, then sign in again; verify Weft returns to the same account.
- [ ] Change the employee's email in Entra (or use a test account with a changed address) and verify the same tenant/object identity still returns to the same Weft account.
- [ ] Try an account from another tenant and verify Weft refuses it with a useful message.
- [ ] When a domain allow list is configured, try an otherwise valid address outside it and verify Weft refuses it.
- [ ] With open signup disabled, verify an uninvited person is refused and an invited person follows the normal invite flow.
- [ ] Link a Microsoft identity to an existing password account only after signing in to that account. Confirm that a separate account asserting the same email is never merged.
- [ ] Verify sign-out and the documented session expiry/revocation behavior. If passwords are to be disabled, confirm a fresh Microsoft sign-in works first and check that password form and API sign-in are unavailable.
- [ ] Repeat the employee sign-in in Thai and verify the button and refusal guidance are clear.

## What the tenant check protects

The tenant id (`tid`) in the signed ID token is the real boundary. A domain allow-list reads the email-like claim (`email`, `preferred_username` or `upn`), which a tenant admin controls, so use it as a convenience on top of the tenant check, not instead of it.
