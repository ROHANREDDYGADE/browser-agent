// preload_token.js

const token = process.env.HOMIE_TOKEN || "";

if (token) {
  chrome.storage.local.set({ qwise_user_token: token }, () => {
    console.log("Token injected:", token);
  });
} else {
  console.warn("No HOMIE_TOKEN found");
}