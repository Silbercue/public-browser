# Installation instructions for AI agents (Cline, Claude Code, Cursor)

This file tells an AI assistant how to install Public Browser without asking the user
any questions. There is nothing to configure: no API key, no port, no browser flags.

## Requirements

- Node.js 20 or newer (`node --version`)
- Google Chrome installed at the platform default location

Nothing else. The server launches and manages Chrome itself.

## Install

Add this entry to the MCP settings file of the host application
(Cline: `cline_mcp_settings.json`, Cursor: `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "public-browser": {
      "command": "npx",
      "args": ["-y", "public-browser@latest"]
    }
  }
}
```

For Claude Code, one command does the same:

```bash
claude mcp add --scope user public-browser npx -y public-browser@latest
```

Restart the host application afterwards — MCP configuration is read at startup.

## Optional: Python Script API

Only if the user asks for LLM-free scripting. Append `--script` to `args`
(`["-y", "public-browser@latest", "--script"]`) and install the client with
`pip install publicbrowser`. Not needed for normal MCP usage.

## Verify

Call the `virtual_desk` tool. A successful install returns the list of open tabs and
the server version; the first tool call launches a visible Chrome window.

If Chrome does not appear, the usual cause is a Chrome instance already running with a
different remote-debugging port — quit Chrome fully and call `virtual_desk` again.
