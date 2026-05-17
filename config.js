const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');

// GET /api/config/sharex — download .sxcu config for ShareX
router.get('/sharex', requireAuth, (req, res) => {
  const base = process.env.BASE_URL || 'https://clinqies.xyz';

  const config = {
    Version: '14.1.0',
    Name: 'clinqies.xyz',
    DestinationType: 'ImageUploader, FileUploader',
    RequestMethod: 'POST',
    RequestURL: `${base}/api/upload`,
    Headers: {
      'X-Api-Key': req.user.api_key
    },
    Body: 'MultipartFormData',
    FileFormName: 'file',
    URL: '$json:url$',
    DeletionURL: '$json:deletion_url$',
    ErrorMessage: '$json:error$'
  };

  const filename = `clinqies-${req.user.username}.sxcu`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(config);
});

// GET /api/config/flameshot — shell script for flameshot/xclip users
router.get('/flameshot', requireAuth, (req, res) => {
  const base = process.env.BASE_URL || 'https://clinqies.xyz';

  const script = `#!/bin/bash
# clinqies.xyz uploader for flameshot/curl
# Generated for: ${req.user.username}
API_KEY="${req.user.api_key}"
BASE_URL="${base}"

FILE="$1"
if [ -z "$FILE" ]; then
  echo "Usage: clinqies-upload <filepath>"
  exit 1
fi

RESPONSE=$(curl -s -X POST "$BASE_URL/api/upload" \\
  -H "X-Api-Key: $API_KEY" \\
  -F "file=@$FILE")

URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])" 2>/dev/null)

if [ -n "$URL" ]; then
  echo "$URL"
  echo -n "$URL" | xclip -selection clipboard 2>/dev/null || echo -n "$URL" | pbcopy 2>/dev/null
  echo "[clinqies] URL copied to clipboard"
else
  echo "[clinqies] upload failed: $RESPONSE"
  exit 1
fi
`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="clinqies-upload.sh"`);
  res.send(script);
});

module.exports = router;
