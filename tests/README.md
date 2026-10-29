# Integration test harness

The Rust integration tests start the server on an ephemeral local port and send HTTP requests through its public routes. Set `DATABASE_URL` to the shared PostgreSQL service; each test creates a uniquely named schema, points its server instance at that schema, and drops it when finished. Cargo runs tests in parallel by default, so tests must never use the shared database's `public` schema or rely on shared fixture rows.

Run the integration suite with the worker container workflow:

```sh
docker run --rm --network host --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e CARGO_HOME=/cargo \
  -e DATABASE_URL=postgres://weft:weft@127.0.0.1:55432/postgres \
  -v "$HOME/.cache/weft-cargo:/cargo" -v "$PWD:/w" -w /w \
  rust:1-bookworm cargo test
```

The API and health routes in the walking skeleton are exercised against real PostgreSQL. Feature tickets should add external-behavior cases to this harness and create all test data in their own schema through the server API or test factories.
