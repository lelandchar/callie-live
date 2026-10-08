# Grace's LiveKit Agents worker. It connects out to LiveKit Cloud; no public port.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev
COPY agent.py ./
CMD ["uv", "run", "--no-sync", "python", "agent.py", "start"]
