# Herdr Narrator

The Narrator speaks short summaries of what the AI coding agents in Herdr panes are doing. This file fixes the words the code and docs use.

## Language

**Narrator**:
The long-lived script that watches Herdr and speaks one-sentence summaries of its panes.
_Avoid_: voice agent, summariser (the summariser is only one part of it)

**Summary**:
The one spoken sentence about what a pane's agent is doing or waiting on, cached per pane and tagged with a revision.
_Avoid_: blurb, recap

**Rollup**:
The short spoken line describing the agents in a tab: counts by state only, blocked first, such as "One blocked, two done." When exactly one agent is blocked and has a cached Summary, that Summary is appended as the reason.
_Avoid_: tab summary

**Blocked alert**:
A spoken line announcing that an unfocused pane's agent needs the user, said once per blocked episode.
_Avoid_: notification

**Provider**:
What writes the Summaries: the Anthropic API, an OpenAI-compatible server, or Bedrock.
_Avoid_: backend (that word means which Herdr the Narrator watches)

**Sidecar**:
The long-lived Python process that renders speech and plays it.
_Avoid_: TTS server
