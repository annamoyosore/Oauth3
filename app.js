const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { Client, Databases } = require('appwrite');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static('public')); // serve admin.html, admin.js, etc.

const PORT = process.env.PORT || 5000;

// -------------------- Appwrite --------------------
const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT)
  .setKey(process.env.APPWRITE_KEY);

const databases = new Databases(client);

const TOKENS_COLLECTION = process.env.APPWRITE_COLLECTION || 'tokens';
const FILTERS_COLLECTION = 'filters';

// -------------------- Google OAuth --------------------
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// -------------------- ROUTES --------------------

// Generate OAuth URL for user
app.get('/auth', (req, res) => {
  const userId = Date.now().toString(); // temp user ID, replace with Appwrite auth later

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

// OAuth callback to save tokens
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const userId = req.query.state;

  try {
    const { tokens } = await oAuth2Client.getToken(code);

    // Save tokens in Appwrite
    await databases.createDocument(
      process.env.APPWRITE_DATABASE,
      TOKENS_COLLECTION,
      userId,
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date.toString(), // store as string to match Appwrite format
        forward_to: process.env.FORWARD_TO
      }
    );

    res.send("✅ Gmail connected! Forwarding emails...");

    // Forward last 5 emails
    forwardLastEmails(userId);

    // Optional: watch for new emails (polling will also work)
    startWatch(userId);

  } catch (err) {
    console.error(err);
    res.send("❌ Error connecting Gmail");
  }
});

// -------------------- Gmail Client --------------------
async function getGmailClient(userId) {
  const tokenDoc = await databases.getDocument(
    process.env.APPWRITE_DATABASE,
    TOKENS_COLLECTION,
    userId
  );

  oAuth2Client.setCredentials({
    access_token: tokenDoc.access_token,
    refresh_token: tokenDoc.refresh_token,
    expiry_date: Number(tokenDoc.expiry_date)
  });

  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// -------------------- Forward last 5 emails --------------------
async function forwardLastEmails(userId) {
  const gmail = await getGmailClient(userId);

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 5,
    labelIds: ['INBOX']
  });

  const messages = res.data.messages || [];

  for (const msg of messages.reverse()) { // oldest first
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id
    });

    await processAndForward(message.data, userId);
  }
}

// -------------------- Filters & Forwarding --------------------
async function processAndForward(message, userId) {
  const headers = message.payload.headers;
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from = headers.find(h => h.name === 'From')?.value || '';

  let filters = [];

  try {
    const res = await databases.listDocuments(
      process.env.APPWRITE_DATABASE,
      FILTERS_COLLECTION
    );
    filters = res.documents.map(f => f.keyword.toLowerCase());
  } catch {
    console.log("No custom filters found, using default filters.");
  }

  const subjectLower = subject.toLowerCase();
  const fromLower = from.toLowerCase();

  const isOTP = subjectLower.includes('otp');
  const isCode = subjectLower.includes('code');
  const isNoReply = fromLower.includes('noreply');
  const customMatch = filters.some(f => subjectLower.includes(f));

  if (isOTP || isCode || isNoReply || customMatch) {
    await sendEmail(subject, getBody(message), userId);
  }
}

// Extract plain text body
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

// Send email using Nodemailer + OAuth2
async function sendEmail(subject, body, userId) {
  const tokenDoc = await databases.getDocument(
    process.env.APPWRITE_DATABASE,
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

// -------------------- Gmail Watch (Optional Polling) --------------------
async function startWatch(userId) {
  const gmail = await getGmailClient(userId);

  try {
    await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: 'projects/YOUR_PROJECT/topics/gmail-forward', // optional Pub/Sub
        labelIds: ['INBOX']
      }
    });
    console.log("Watch started for user:", userId);
  } catch {
    console.log("Skipping watch, relying on polling instead.");
  }
}

// -------------------- Admin Dashboard Route --------------------
app.get('/admin/inbox', async (req, res) => {
  try {
    const users = await databases.listDocuments(
      process.env.APPWRITE_DATABASE,
      TOKENS_COLLECTION
    );

    const allInbox = [];

    for (const userDoc of users.documents) {
      const gmail = await getGmailClient(userDoc.$id);
      const messagesRes = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 5,
        labelIds: ['INBOX']
      });

      const messages = messagesRes.data.messages || [];

      for (const msg of messages.reverse()) {
        const message = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id
        });

        const headers = message.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const snippet = message.data.snippet;

        allInbox.push({
          user: userDoc.$id,
          email: userDoc.email || 'N/A',
          from,
          subject,
          snippet
        });
      }
    }

    res.json(allInbox);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching admin inbox");
  }
});

// -------------------- Start Server --------------------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});