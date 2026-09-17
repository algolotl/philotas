# @philotas/mcp

Model Context Protocol (MCP) server for Philotas (the installable binary is
`philotas-mcp`). It exposes read-only tools
over a running Philotas deployment, plus developer scaffolding for authoring and
validating data-source connectors.

- Read-only by design: no tool writes back to a deployment.
- scaffold_connector is the only tool that touches disk, and it writes only into
  the connectors/ directory under your current working directory.
- No secrets as tool arguments: configure the deployment URL via PHILOTAS_URL.

## Quickstart

```bash
# Point the server at your Philotas deployment
export PHILOTAS_URL=http://localhost:8788

# Start the MCP server over stdio
npx -y @philotas/mcp

# Verify connectivity and configuration (exit 0 means healthy)
npx -y -p @philotas/mcp philotas-mcp doctor

# Or install it and use the binary directly
npm i -g @philotas/mcp
philotas-mcp doctor
```

Run the server from your Philotas checkout so scaffold_connector and run_tests
operate on the project.

### Authentication

Deployments guard their API with sessions. Provide credentials one of three
ways (env vars, read from the process environment):

| Env | Meaning |
| --- | --- |
| PHILOTAS_TOKEN | a session token value, attached as the session cookie |
| PHILOTAS_USER + PHILOTAS_PASSWORD | log in once at startup, reuse the session |
| PHILOTAS_GUEST=1 | bootstrap a read-only guest session (trial deployments) |

Against the public trial:

```bash
PHILOTAS_URL=https://trial.philotas.com PHILOTAS_GUEST=1 npx -y -p @philotas/mcp philotas-mcp doctor
```

## Configuration

### Claude Desktop

Add to claude_desktop_config.json:

```json
{
  "mcpServers": {
    "philotas": {
      "command": "npx",
      "args": ["-y", "@philotas/mcp"],
      "env": { "PHILOTAS_URL": "http://localhost:8788" }
    }
  }
}
```

### Cursor

Add to .cursor/mcp.json:

```json
{
  "mcpServers": {
    "philotas": {
      "command": "npx",
      "args": ["-y", "@philotas/mcp"],
      "env": { "PHILOTAS_URL": "http://localhost:8788" }
    }
  }
}
```

### VS Code

Add to .vscode/mcp.json:

```json
{
  "servers": {
    "philotas": {
      "command": "npx",
      "args": ["-y", "@philotas/mcp"],
      "env": { "PHILOTAS_URL": "http://localhost:8788" }
    }
  }
}
```

## Tools

| Tool | Arguments | Maps to |
| --- | --- | --- |
| philotas_status | none | GET /api/status |
| philotas_regions | none | GET /api/regions |
| philotas_feed | feed (required), region (optional) | GET /api/feeds/{feed}?region= |
| philotas_graph | region (optional) | GET /api/graph?region= |
| philotas_search | query (required), region (optional) | GET /api/search?q=&region= |
| philotas_alerts | region (optional) | GET /api/alerts?region= |
| philotas_detections | region (optional) | GET /api/detections?region= |
| scaffold_connector | name (required), kind (api or datalake, required), endpoint (optional) | writes connectors/<name>.js |
| validate_connector | path (required) | imports the file and runs its pull() |
| run_tests | none | runs node --test in the working directory |

## Security

- Every tool except scaffold_connector and run_tests issues a read-only HTTP
  request to PHILOTAS_URL; none of them mutate the deployment.
- scaffold_connector writes a single connector template into the connectors/
  directory under the current working directory, and nothing else.
- run_tests spawns node --test in the current working directory and reports the
  pass/fail counts.
- The server accepts no credentials or secrets as tool arguments.

## License

Apache-2.0.
