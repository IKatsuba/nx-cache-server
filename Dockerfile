FROM denoland/deno:2.7.14

WORKDIR /app

# Copy only the manifests first so dependency installation stays cached.
COPY deno.json deno.lock ./
RUN deno install

# Copy only the server entrypoint — never the whole build context.
COPY src/index.ts ./src/index.ts

CMD ["deno", "task", "start"]
