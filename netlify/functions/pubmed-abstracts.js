/**
 * Netlify serverless entry: runs the same PubMed pipeline as pubmed_abstracts.js (server-side; avoids browser CORS).
 * POST JSON body: { "text": "1. Author A: Title. Journal. 2020; ..." }
 * Response: full HTML document (text/html).
 */

const { buildAbstractsHtml } = require("../../pubmed_abstracts_netlify.js");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      body: "Method not allowed. Use POST with JSON: {\"text\":\"...\"}"
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Invalid JSON body." })
    };
  }

  const text = typeof parsed.text === "string" ? parsed.text : "";

  try {
    const { fullHtml, lineCount } = await buildAbstractsHtml(text, { logProgress: false });

    if (lineCount === 0) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "No non-empty reference lines in input." })
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/html; charset=utf-8"
      },
      body: fullHtml
    };
  } catch (err) {
    console.error("pubmed-abstracts function error:", err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: err.message || "Server error" })
    };
  }
};
