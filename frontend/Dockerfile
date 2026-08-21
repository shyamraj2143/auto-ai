FROM node:22-alpine AS build

WORKDIR /app
COPY frontend/package*.json ./
RUN npm install

COPY frontend ./
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Railway injects PORT at runtime. Keep 8080 as the container default and
# rewrite the nginx listener to the actual Railway-assigned port on startup.
EXPOSE 8080

CMD ["sh", "-c", "PORT=${PORT:-8080}; sed -i -E "s/listen 8080;/listen ${PORT};/" /etc/nginx/conf.d/default.conf; nginx -t && exec nginx -g 'daemon off;'"]
