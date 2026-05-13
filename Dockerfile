FROM denoland/deno:2.7.14

WORKDIR /app
COPY . .
RUN deno install

CMD ["deno", "task", "start"]
