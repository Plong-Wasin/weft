# Microsoft Graph mail

Weft can send its email (sign-up verification, password reset, and notification digests) through Microsoft Graph instead of SMTP. This is for a company on Microsoft 365 that cannot or will not enable SMTP AUTH on a mailbox. The **Mail transport** is chosen once for the whole instance with `MAIL_TRANSPORT`. Unset or `smtp` keeps SMTP. `graph` sends every message through Graph `sendMail` as one sender mailbox.

Weft uses an app-only sign-in to Microsoft. It does not receive mail, and it does not use Graph for anything except sending.

## Register a separate application

Create a new app registration for this purpose. Do not reuse the app from [Microsoft Entra sign-in](microsoft-entra-sign-in.md). A leaked sign-in secret must not be able to send mail as the sender mailbox.

1. In the Microsoft Entra admin center, create an app registration for **Accounts in this organizational directory only (single tenant)**. It needs no redirect URI.
2. Under **API permissions**, add **Microsoft Graph**, choose **Application permissions**, and select `Mail.Send`.
3. Select **Grant admin consent for** your tenant. The permission must show as granted. Application permissions do nothing until an administrator consents.
4. Under **Certificates & secrets**, create a client secret and copy its value once.
5. From the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.

## Limit the app to the sender mailbox

Once `Mail.Send` is consented, the app can send as any mailbox in the tenant. Restrict it with an Exchange application access policy. Put the sender mailbox in a mail-enabled security group, then run this in Exchange Online PowerShell (`Connect-ExchangeOnline`) as an Exchange administrator:

```powershell
New-ApplicationAccessPolicy -AppId "<application (client) ID>" -PolicyScopeGroupId "weft-mail-sender@company.example" -AccessRight RestrictAccess -Description "Weft sends mail only as the sender mailbox"
Test-ApplicationAccessPolicy -Identity "sender@company.example" -AppId "<application (client) ID>"
Test-ApplicationAccessPolicy -Identity "someone-else@company.example" -AppId "<application (client) ID>"
```

The first test should report `Granted` and the second `Denied`. A new policy can take a while to take effect. If the sender is denied at first, wait and test again.

## Configure Weft

Set these in `.env` or the deployment's environment:

| Variable | Value |
| --- | --- |
| `MAIL_TRANSPORT` | `graph` |
| `GRAPH_MAIL_TENANT_ID` | the Directory (tenant) ID GUID |
| `GRAPH_MAIL_CLIENT_ID` | the mail app's Application (client) ID |
| `GRAPH_MAIL_CLIENT_SECRET` | the mail app's client secret value |
| `GRAPH_MAIL_SENDER` | the sender mailbox address, for example `sender@company.example` |

The `GRAPH_MAIL_*` values are separate from `MICROSOFT_*`. The tenant ID may be the same, but the client ID and secret must belong to the mail app.

Restart the API and the worker. Both read the Mail transport at startup.

The rules for the settings:

- With `MAIL_TRANSPORT=graph` and any of the four `GRAPH_MAIL_*` values missing, email is off. Weft logs one warning that names the missing variables. It does not fall back to SMTP, and the web app reports email as not set up.
- With `MAIL_TRANSPORT` unset or `smtp`, Weft uses the `SMTP_*` settings exactly as before. The `GRAPH_MAIL_*` values are ignored.
- Any other `MAIL_TRANSPORT` value (for example `Graph` or `grpah`) stops the API and the worker at startup. The error lists the accepted values, `smtp` and `graph`.

## Check it with "forgot password"

Use your own account to confirm delivery:

1. Sign out of Weft, open the sign-in page, and choose the forgot password link.
2. Enter your own email address.
3. The reset email should arrive within a few minutes, from the sender mailbox address. Check your spam folder too.
4. Open the link and set a new password.

If nothing arrives, look in the API and worker logs for `Email delivery failed:` and use the table below.

## Errors

A failed send reports `Email delivery failed: <code>`. The code names the failure class. It never contains the secret, a token, or the message text.

| Code | Meaning |
| --- | --- |
| `TOKEN_HTTP_<status>:<error>` | Microsoft refused the token request. `TOKEN_HTTP_401:invalid_client` means the client secret is wrong or expired. |
| `HTTP_<status>:<code>` | `sendMail` was refused, with the Graph `error.code` when Microsoft returns one. `HTTP_403:ErrorAccessDenied` usually means `Mail.Send` is not consented or the access policy does not cover the sender. |
| `HTTP_429` | Microsoft throttled the request. |
| `HTTP_5xx` | A Microsoft outage or server error. |
| `TIMEOUT` | Microsoft did not answer within 10 seconds. |
| `NETWORK` | The connection to Microsoft failed. |

Weft does not retry inside the transport. Notification digests use the existing job retry, so a throttle or outage is retried later.

## Rotate the client secret

Client secrets expire. Rotate before the expiry date:

1. In the mail app, under **Certificates & secrets**, create a new client secret and copy its value once.
2. Set `GRAPH_MAIL_CLIENT_SECRET` to the new value in the deployment environment.
3. Restart the API and the worker. A restart also clears the cached access token.
4. Send a test with "forgot password" as described above.
5. Delete the old secret in Entra.

Never put the secret in a client bundle or commit it.

## Limits

- Commercial Microsoft cloud only. The endpoints are `login.microsoftonline.com` and `graph.microsoft.com`. Sovereign clouds such as GCC High and China are not supported. No environment variable changes these endpoints.
- Plain text only. HTML mail and attachments are not sent.
- One recipient per message.
- The From address is the sender mailbox. `SMTP_FROM` is not used.
- Sent messages are not saved to the sender mailbox's Sent Items.
- There is no fallback to SMTP. A Graph failure stays a failure.
- The access token is kept in memory until 60 seconds before it expires, then requested again. Each API or worker process keeps its own token.
- Each HTTP request times out after 10 seconds.

## Manual verification checklist

Automated tests use a local fake Microsoft server. They do not contact Microsoft, so real-tenant behavior is **unverified** until an operator completes this checklist with the company's tenant:

- [ ] Confirm the mail app is single-tenant and `Mail.Send` shows as granted for the tenant.
- [ ] Confirm `Test-ApplicationAccessPolicy` reports `Granted` for the sender and `Denied` for another mailbox.
- [ ] Set `MAIL_TRANSPORT=graph` and the four `GRAPH_MAIL_*` values, restart the API and the worker, and confirm no warning names missing `GRAPH_MAIL_*` variables.
- [ ] Use "forgot password" with your own account and verify the reset email arrives from the sender mailbox.
- [ ] Create a new account with a test address and verify the verification email arrives.
- [ ] Rotate the client secret as described above and verify a fresh send works before deleting the old secret.
- [ ] Verify the sender mailbox's Sent Items does not contain the test messages.
