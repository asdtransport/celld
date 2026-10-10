#!/bin/sh
# Generate the edge's ES256 (P-256) signing key and print the one-line public key for the Worker.
#   sh deploy/oss/keygen.sh            -> deploy/oss/edge/jwt/sign.pem (private, keep on the edge only)
# Then set APP_AUTH_PUBLIC_KEY_B64=<printed value> in the site's .env and run `make celld-deploy`.
set -eu
dir=$(dirname "$0")/edge/jwt
mkdir -p "$dir"
if [ -f "$dir/sign.pem" ]; then echo "exists: $dir/sign.pem (delete it to rotate)" >&2
else
  openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$dir/sign.pem"
  chmod 600 "$dir/sign.pem"
fi
printf 'APP_AUTH_PUBLIC_KEY_B64=%s\n' "$(openssl pkey -in "$dir/sign.pem" -pubout | grep -v -- '-----' | tr -d '\n')"
