# Postdom MCP

The MCP server for [Postdom](https://postdom.com). Postdom turns your website into short videos, slideshows and single images in your brand, and posts them once you approve. With this server, an MCP-compatible AI assistant can read a Postdom workspace, upload media, create and schedule posts, and read how they performed.

## Remote server (recommended)

Streamable HTTP endpoint, with OAuth sign-in:

```
https://api.postdom.com/mcp
```

Add it as a remote / custom connector in your MCP client. Once connected, `tools/list` shows the tools the hosted server offers.

## Local server (npm)

The package is published as [`@postdom/mcp`](https://www.npmjs.com/package/@postdom/mcp). Create a workspace key in Postdom (Accounts), then add:

```json
{
  "mcpServers": {
    "postdom": {
      "command": "npx",
      "args": ["-y", "@postdom/mcp"],
      "env": {
        "POSTDOM_API_KEY": "your-workspace-key"
      }
    }
  }
}
```

The key is scoped to one workspace and shown once. Keep it in your client's secure configuration; never commit it. Connecting a social account is always done by a person in Postdom (OAuth).

## Tools

1. `get_workspace_status` - workspace status
2. `get_brief` - the workspace brief
3. `get_digest` - the latest learning digest
4. `get_learning` - shared account learning
5. `list_accounts` - connected social accounts
6. `connect_account` - start connecting a social account
7. `upload_media` - get a short-lived upload URL for a local video or image
8. `get_media` - check an upload until it is stored
9. `publish_video` - publish a stored video to one or more accounts
10. `submit_plan` - submit a publication plan
11. `get_plan` - read a publication plan
12. `get_publish` - status of one post
13. `list_posts` - list posts
14. `get_performance` - performance over a time window
15. `get_best_posts` - best-performing posts
16. `create_slideshow` - render a branded slideshow

Posts go to TikTok, Instagram, YouTube, Facebook, LinkedIn, X, Threads, Bluesky and Snapchat.

## About this repository

This repository is the source for reference. It imports shared schemas from Postdom's internal `@postdom/core` package, which is not published, so it does not build on its own. To run the server, use the remote endpoint or the npm package, which ships with everything bundled.

Docs: https://postdom.com/docs
Support: support@postdom.com

## License

MIT
