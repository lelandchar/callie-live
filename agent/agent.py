"""Grace Liu, the AI customer in the Callie Live Assistant demo.

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
log = logging.getLogger("customer")


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
    # Each persona's avatar publishes under its own identity, so two people can share a call.
    avatar_kwargs = {}
    if meta.get("avatarIdentity"):
        avatar_kwargs = {"avatar_participant_identity": meta["avatarIdentity"], "avatar_participant_name": meta.get("avatarName") or meta["avatarIdentity"]}
    avatar = AvatarSession(
        avatar_id=meta.get("avatarId") or os.environ["SPATIUS_AVATAR_ID"],
        audio_format=os.getenv("SPATIUS_AUDIO_FORMAT", "pcm_s16le"),
        **avatar_kwargs,
    )
    await avatar.start(session, room=ctx.room)

    # The avatar plays the voice in sync with the face, so the agent doesn't publish its own audio
    # track. A teammate persona (textOnly) hears only the messages addressed to it. A network blip
    # makes the browser rejoin; the agent stays for that. When the call really ends, Callie's
    # server deletes the room, which ends this job.
    room_options = RoomOptions(audio_output=False, close_on_disconnect=False)
    if meta.get("textOnly"):
        room_options = RoomOptions(audio_output=False, audio_input=False, close_on_disconnect=False)
    await session.start(agent=Grace(prompt), room=ctx.room, room_options=room_options)
    log.info("%s joined %s", meta.get("avatarName") or "Customer", ctx.room.name)

    if meta.get("greet", True):
        await session.generate_reply(
            instructions=meta.get("greeting") or "The call has started. Thank Jordan for making the time in one short sentence, then ask your first question."
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
