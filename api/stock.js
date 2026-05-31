/**
 * Vercel Serverless Function: Stock Data API
 * Fetches real stock data from Yahoo Finance (server-side, no CORS issues)
 *
 * Usage: /api/stock?symbol=NVDA
 *        /api/stock?symbol=NVDA,TSLA,GOOGL
 */

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const symbol = req.query.symbol || req.query.ticker;
    const range = req.query.range || '3mo';
    const interval = req.query.interval || '1d';

    if (!symbol) {
      return res.status(400).json({
        error: 'Missing symbol parameter',
        usage: '/api/stock?symbol=NVDA or /api/stock?symbol=NVDA,TSLA,GOOGL'
      });
    }

    const symbols = symbol.toUpperCase().split(',').map(s => s.trim());
    const results = {};

    // Fetch data for each symbol
    for (const sym of symbols) {
      try {
        // Yahoo Finance chart endpoint
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          }
        });

        if (!response.ok) {
          results[sym] = { error: `HTTP ${response.status}` };
          continue;
        }

        const data = await response.json();

        if (!data.chart?.result?.[0]) {
          results[sym] = { error: 'No data found' };
          continue;
        }

        const result = data.chart.result[0];
        const meta = result.meta;
        const adjClose = result.indicators?.adjclose?.[0];
        const quote = result.indicators?.quote?.[0];
        const timestamps = result.timestamp || [];

        // Use adjusted close for split-adjusted prices
        const closes = adjClose?.adjclose || quote?.close || [];

        // Find last valid price
        let lastValidClose = null;
        let lastValidIndex = -1;
        let previousClose = null;

        for (let i = closes.length - 1; i >= 0; i--) {
          if (closes[i] && closes[i] > 0 && closes[i] < 10000) {
            if (!lastValidClose) {
              lastValidClose = closes[i];
              lastValidIndex = i;
            } else if (previousClose === null && i < lastValidIndex) {
              previousClose = closes[i];
              break;
            }
          }
        }

        if (!lastValidClose) {
          results[sym] = { error: 'No valid price data' };
          continue;
        }

        if (previousClose === null) previousClose = lastValidClose;

        const change = lastValidClose - previousClose;
        const changePct = previousClose > 0 ? (change / previousClose) * 100 : 0;

        // Build history array
        const history = [];
        for (let i = 0; i <= lastValidIndex && i < timestamps.length; i++) {
          if (closes[i] && closes[i] > 0) {
            history.push({
              time: timestamps[i],
              open: quote?.open?.[i] || closes[i],
              high: quote?.high?.[i] || closes[i],
              low: quote?.low?.[i] || closes[i],
              close: closes[i]
            });
          }
        }

        results[sym] = {
          symbol: sym,
          name: meta.shortName || meta.symbol || sym,
          price: lastValidClose,
          prevClose: previousClose,
          change: change,
          changePct: changePct,
          dayHigh: meta.regularMarketDayHigh || lastValidClose * 1.02,
          dayLow: meta.regularMarketDayLow || lastValidClose * 0.98,
          volume: meta.regularMarketVolume || 0,
          marketCap: meta.marketCap || 0,
          yearHigh: meta.fiftyTwoWeekHigh || lastValidClose * 1.5,
          yearLow: meta.fiftyTwoWeekLow || lastValidClose * 0.5,
          currency: meta.currency || 'USD',
          exchange: meta.exchangeName || 'NMS',
          history: history,
          timestamp: Date.now()
        };

      } catch (e) {
        results[sym] = { error: e.message };
      }
    }

    // Return single result or array based on input
    const response = symbols.length === 1
      ? results[symbols[0]]
      : { stocks: results, timestamp: Date.now() };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Stock API Error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};