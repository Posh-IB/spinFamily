import { getStore } from '@netlify/blobs';
import nodemailer from 'nodemailer';
import { processWelcome } from '../../lib/pilot-welcome.mjs';

// Event-only handler. No public fetch or recipient-sending endpoint.
// Netlify verifies the platform event's signature before invoking this method.
export default {
  async formSubmitted(event) {
    await processWelcome(event.data, {
      env: name => process.env[name],
      storeFactory: () => getStore({name:'pilot-welcome-v1',consistency:'strong'}),
      send: async (settings, message) => {
        const transport = nodemailer.createTransport(settings);
        try {return await transport.sendMail(message);} finally {transport.close();}
      },
      log: state => console.info(JSON.stringify({component:'pilot-welcome',state})),
    });
  },
};
