"""Grace Liu, the AI customer in the Callie Live demo.

A LiveKit Agents worker. Gemini 3.8 Live is Grace's voice and brain, and a Spatius avatar
gives her a face. Callie's server dispatches this agent by name when Jordan joins the call,
and passes the persona in the job metadata, so the prompt lives in one place
(callie-live/lib/persona.js) for both the voice-only roleplay and this video call.
"""

import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, AutoSubscribe, JobContext, WorkerOptions, cli
from livekit.agents.voice.room_io import RoomOptions
from livekit.plugins import google
from livekit.plugins.spatius import AvatarSession

# Local runs share callie-live/.env; on Railway the variables come from the service.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

AGENT_NAME = os.getenv("CALLIE_AGENT_NAME", "callie-customer")
log = logging.getLogger("priya")


def job_metadata(raw: str | None) -> dict:
    try:
        data = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


class Grace(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


async def entrypoint(ctx: JobContext) -> None:
    meta = job_metadata(ctx.job.metadata)
    prompt = meta.get("prompt")
    if not prompt:
        raise RuntimeError("Dispatch metadata has no persona prompt; start calls from Callie's server.")

    # The avatar has to register its playback handlers on a connected participant.
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=meta.get("model") or os.getenv("CALLIE_PERSONA_MODEL", "gemini-3.8-live"),
            voice=meta.get("voice") or os.getenv("CALLIE_PERSONA_VOICE", "Aoede"),
            api_key=os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"),
        )
    )

    # Raw PCM to Spatius: Ogg Opus would need the native libopus on every machine that runs this.
    avatar = AvatarSession(
        avatar_id=meta.get("avatarId") or os.environ["SPATIUS_AVATAR_ID"],
        audio_format=os.getenv("SPATIUS_AUDIO_FORMAT", "pcm_s16le"),
    )
    await avatar.start(session, room=ctx.room)

    # The avatar plays Grace's voice in sync with her face, so the agent doesn't publish its own
    # audio track. A network blip makes the browser rejoin; Grace stays for that. When the call
    # really ends, Callie's server deletes the room, which ends this job.
    await session.start(
        agent=Grace(prompt),
        room=ctx.room,
        room_options=RoomOptions(audio_output=False, close_on_disconnect=False),
    )
    log.info("Grace joined %s", ctx.room.name)

    await session.generate_reply(
        instructions="The call has started. Thank Jordan for making the time in one short sentence, then ask your first question."
    )


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=AGENT_NAME,
            # LiveKit stops sending jobs to a worker whose machine is busier than the threshold.
            # This worker only ever runs Grace, so it accepts calls on a busy laptop too.
            load_threshold=float(os.getenv("CALLIE_AGENT_LOAD_THRESHOLD", "0.98")),
            num_idle_processes=int(os.getenv("CALLIE_AGENT_IDLE_PROCESSES", "1")),
            initialize_process_timeout=30.0,
        )
    )
