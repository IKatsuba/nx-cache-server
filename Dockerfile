FROM denoland/deno:2.3.3

WORKDIR /app
COPY . .
RUN deno install

CMD ["deno", "task", "start"]
