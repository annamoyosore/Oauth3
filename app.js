const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { Client, Databases } = require('appwrite');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static('public')); // serve index.html

const PORT = process.env.PORT || 5000;

// -------------------- Appwrite --------------------
const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT)
  .setKey(process.env.APPWRITE_KEY);

const databases = new Databases(client);

const TOKENS_COLLECTION = 'tokens';
const FILTERS_COLLECTION = 'filters';

// -------------------- Google OAuth --------------------
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// -------------------- ROUTES --------------------

// Get OAuth URL
app.get('/auth', (req, res) => {
  const userId = Date.now().toString(); // simple user id (replace with Appwrite auth later)

  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send'
    ],
    state: userId
  });

  res.send({ url });
});

// OAuth callback
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const userId = req.query.state;

  try {
    const { tokens } = await oAuth2Client.getToken(code);

    await databases.createDocument(
      process.env.APPWRITE_PROJECT,
      TOKENS_COLLECTION,
      userId,
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
        forward_to: "your-email@example.com" // change per user later
      }
    );

    res.send("✅ Gmail connected! Forwarding emails...");

    forwardLastEmails(userId);
    startWatch(userId);

  } catch (err) {
    console.error(err);
    res.send("❌ Error connecting Gmail");
  }
});

// -------------------- Gmail Logic --------------------

async function getGmailClient(userId) {
  const tokenDoc = await databases.getDocument(
    process.env.APPWRITE_PROJECT,
    TOKENS_COLLECTION,
    userId
  );

  oAuth2Client.setCredentials({
    access_token: tokenDoc.access_token,
    refresh_token: tokenDoc.refresh_token,
    expiry_date: tokenDoc.expiry_date
  });

  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// Forward last 5 emails
async function forwardLastEmails(userId) {
  const gmail = await getGmailClient(userId);

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 5
  });

  const messages = res.data.messages || [];

  for (const msg of messages) {
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id
    });

    await processAndForward(message.data, userId);
  }
}

// Filter + Forward
async function processAndForward(message, userId) {
  const headers = message.payload.headers;

  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from = headers.find(h => h.name === 'From')?.value || '';

  let filters = [];

  try {
    const res = await databases.listDocuments(
      process.env.APPWRITE_PROJECT,
      FILTERS_COLLECTION
    );
    filters = res.documents.map(f => f.keyword);
  } catch {}

  const isOTP = subject.toLowerCase().includes('otp');
  const isNoReply = from.toLowerCase().includes('noreply');
  const customMatch = filters.some(f => subject.includes(f));

  if (isOTP || isNoReply || customMatch) {
    await sendEmail(subject, getBody(message), userId);
  }
}

// Extract body
function getBody(message) {
  let body = '';

  const parts = message.payload.parts || [];

  parts.forEach(part => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      body += Buffer.from(part.body.data, 'base64').toString();
    }
  });

  return body;
}

// Send email
async function sendEmail(subject, body, userId) {
  const tokenDoc = await databases.getDocument(
    process.env.APPWRITE_PROJECT,
    TOKENS_COLLECTION,
    userId
  );

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: 'me',
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: tokenDoc.refresh_token
    }
  });

  await transporter.sendMail({
    from: 'me',
    to: tokenDoc.forward_to,
    subject: `[Forwarded] ${subject}`,
    text: body
  });

  console.log("Forwarded:", subject);
}

// Gmail Push Watch (fast ~2–3 sec)
async function startWatch(userId) {
  const gmail = await getGmailClient(userId);

  await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: 'projects/YOUR_PROJECT/topics/gmail-forward',
      labelIds: ['INBOX']
    }
  });

  console.log("Watch started for user:", userId);
}

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
