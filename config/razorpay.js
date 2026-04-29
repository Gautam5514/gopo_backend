const Razorpay = require("razorpay");

const RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1";

const getRazorpayConfig = () => ({
  keyId: String(process.env.RAZORPAY_KEY_ID || "").trim(),
  keySecret: String(process.env.RAZORPAY_KEY_SECRET || "").trim(),
  webhookSecret: String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim(),
});

const getRazorpayClient = () => {
  const { keyId, keySecret } = getRazorpayConfig();
  if (!keyId || !keySecret) {
    throw new Error("Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

const createGatewayError = (message, statusCode = 502, gatewayStatus = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.gatewayStatus = gatewayStatus;
  return error;
};

const createRazorpayOrder = async (payload) => {
  const { keyId, keySecret } = getRazorpayConfig();
  if (!keyId || !keySecret) {
    throw createGatewayError(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
      500
    );
  }

  let response;
  try {
    response = await fetch(`${RAZORPAY_API_BASE_URL}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw createGatewayError(
      "Could not reach Razorpay. Check internet connection and Razorpay credentials.",
      502
    );
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const gatewayMessage =
      data?.error?.description ||
      data?.error?.reason ||
      data?.error?.code ||
      text ||
      "Razorpay rejected the order request.";

    throw createGatewayError(
      gatewayMessage,
      response.status >= 500 ? 502 : 400,
      response.status
    );
  }

  if (!data?.id) {
    throw createGatewayError("Razorpay returned an invalid order response.", 502);
  }

  return data;
};

module.exports = {
  createRazorpayOrder,
  getRazorpayClient,
  getRazorpayConfig,
};
