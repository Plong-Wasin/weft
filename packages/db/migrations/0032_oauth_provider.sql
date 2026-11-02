CREATE TABLE oauth_client (
  id text PRIMARY KEY,
  client_id text NOT NULL UNIQUE,
  client_secret text,
  client_discovery_id text,
  disabled boolean DEFAULT false,
  skip_consent boolean,
  enable_end_session boolean,
  subject_type text,
  sector_identifier text,
  scopes text[],
  client_credentials_scopes text[] DEFAULT '{}',
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamp,
  updated_at timestamp,
  name text,
  uri text,
  icon text,
  contacts text[],
  tos text,
  policy text,
  software_id text,
  software_version text,
  software_statement text,
  redirect_uris text[] NOT NULL,
  post_logout_redirect_uris text[],
  backchannel_logout_uri text,
  backchannel_logout_session_required boolean,
  frontchannel_logout_uri text,
  frontchannel_logout_session_required boolean,
  token_endpoint_auth_method text,
  application_type text,
  jwks text,
  jwks_uri text,
  grant_types text[],
  response_types text[],
  require_pkce boolean,
  dpop_bound_access_tokens boolean DEFAULT false,
  reference_id text,
  metadata jsonb
);
--> statement-breakpoint
CREATE INDEX oauthClient_userId_idx ON oauth_client(user_id);
--> statement-breakpoint
CREATE TABLE oauth_resource (
  id text PRIMARY KEY,
  identifier text NOT NULL UNIQUE,
  name text NOT NULL,
  access_token_ttl integer,
  refresh_token_ttl integer,
  signing_algorithm text,
  signing_key_id text,
  allowed_scopes text[],
  custom_claims jsonb,
  dpop_bound_access_tokens_required boolean DEFAULT false,
  disabled boolean DEFAULT false,
  created_at timestamp,
  updated_at timestamp,
  policy_version integer DEFAULT 1,
  metadata jsonb
);
--> statement-breakpoint
CREATE TABLE oauth_client_resource (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  resource_id text NOT NULL REFERENCES oauth_resource(identifier) ON DELETE CASCADE,
  metadata jsonb,
  created_at timestamp
);
--> statement-breakpoint
CREATE INDEX oauthClientResource_clientId_idx ON oauth_client_resource(client_id);
--> statement-breakpoint
CREATE INDEX oauthClientResource_resourceId_idx ON oauth_client_resource(resource_id);
--> statement-breakpoint
CREATE UNIQUE INDEX oauthClientResource_clientId_resourceId_idx ON oauth_client_resource(client_id, resource_id);
--> statement-breakpoint
CREATE TABLE oauth_refresh_token (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  session_id text REFERENCES session(id) ON DELETE SET NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  reference_id text,
  authorization_code_id text,
  resources text[],
  requested_user_info_claims text[],
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL,
  revoked timestamp,
  rotated_at timestamp,
  rotation_replay_response text,
  rotation_replay_expires_at timestamp,
  auth_time timestamp,
  acr text,
  amr text[],
  confirmation jsonb,
  scopes text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX oauthRefreshToken_clientId_idx ON oauth_refresh_token(client_id);
--> statement-breakpoint
CREATE INDEX oauthRefreshToken_sessionId_idx ON oauth_refresh_token(session_id);
--> statement-breakpoint
CREATE INDEX oauthRefreshToken_userId_idx ON oauth_refresh_token(user_id);
--> statement-breakpoint
CREATE INDEX oauthRefreshToken_authorizationCodeId_idx ON oauth_refresh_token(authorization_code_id);
--> statement-breakpoint
CREATE TABLE oauth_access_token (
  id text PRIMARY KEY,
  token text UNIQUE,
  client_id text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  session_id text REFERENCES session(id) ON DELETE SET NULL,
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  reference_id text,
  authorization_code_id text,
  resources text[],
  requested_user_info_claims text[],
  refresh_id text REFERENCES oauth_refresh_token(id) ON DELETE CASCADE,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL,
  revoked timestamp,
  confirmation jsonb,
  scopes text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX oauthAccessToken_clientId_idx ON oauth_access_token(client_id);
--> statement-breakpoint
CREATE INDEX oauthAccessToken_sessionId_idx ON oauth_access_token(session_id);
--> statement-breakpoint
CREATE INDEX oauthAccessToken_userId_idx ON oauth_access_token(user_id);
--> statement-breakpoint
CREATE INDEX oauthAccessToken_authorizationCodeId_idx ON oauth_access_token(authorization_code_id);
--> statement-breakpoint
CREATE INDEX oauthAccessToken_refreshId_idx ON oauth_access_token(refresh_id);
--> statement-breakpoint
CREATE TABLE oauth_consent (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  reference_id text,
  resources text[],
  requested_user_info_claims text[],
  scopes text[] NOT NULL,
  created_at timestamp,
  updated_at timestamp
);
--> statement-breakpoint
CREATE INDEX oauthConsent_clientId_idx ON oauth_consent(client_id);
--> statement-breakpoint
CREATE INDEX oauthConsent_userId_idx ON oauth_consent(user_id);
--> statement-breakpoint
CREATE TABLE oauth_client_assertion (
  id text PRIMARY KEY,
  expires_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE jwks (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamp NOT NULL,
  expires_at timestamp,
  alg text,
  crv text
);
