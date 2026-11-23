ALTER TABLE cli_device_authorizations
  ADD COLUMN previous_token_id uuid REFERENCES api_tokens(id) ON DELETE CASCADE;
