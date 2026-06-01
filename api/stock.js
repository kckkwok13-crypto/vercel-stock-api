/**
 * Vercel Serverless Function: Stock Data API
 * Features:
 * - Multi-source fallback (Yahoo Finance → Alpha Vantage → Finnhub)
 * - In-memory caching (5 min TTL)
 * - Technical indicators calculation (RSI, MACD, MA, Bollinger, etc.)
 *
 * Usage: /api/stock?symbol=NVDA
 */

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const symbol = (req.query.symbol || req.query.ticker || '').toUpperCase().trim();
    const range = req.query.range || '3mo';
    const interval = req.query.interval || '1d';
    const includeIndicators = req.query.indicators !== 'false';

    if (!symbol) {
      return res.status(400).json({
        error: 'Missing symbol parameter',
        usage: '/api/stock?symbol=NVDA'
      });
    }

    // Check cache first
    const cacheKey = `stock_${symbol}_${range}`;
    if (global.stockCache && global.stockCache[cacheKey]) {
      const cached = global.stockCache[cacheKey];
      if (Date.now() - cached.timestamp < 300000) { // 5 min cache
        console.log(`Cache hit for ${symbol}`);
        return res.status(200).json(cached.data);
      }
    }

    let stockData = null;
    let source = '';

    // Strategy 1: Yahoo Finance (primary)
    try {
      stockData = await fetchFromYahoo(symbol, range, interval);
      source = 'yahoo';
    } catch (e) {
      console.warn(`Yahoo failed for ${symbol}: ${e.message}`);
    }

    // Strategy 2: Alpha Vantage (backup)
    if (!stockData) {
      try {
        // Free API key - rate limited but reliable
        const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo';
        const avUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`;
        const avResponse = await fetch(avUrl);
        const avData = await avResponse.json();

        if (avData['Global Quote'] && avData['Global Quote']['05. price']) {
          const q = avData['Global Quote'];
          stockData = {
            symbol: symbol,
            price: parseFloat(q['05. price']),
            prevClose: parseFloat(q['08. previous close']),
            change: parseFloat(q['09. change']),
            changePct: parseFloat(q['10. change percent']?.replace('%', '') || 0),
            dayHigh: parseFloat(q['03. high']),
            dayLow: parseFloat(q['04. low']),
            volume: parseInt(q['06. volume'] || 0),
            marketCap: 0,
            yearHigh: parseFloat(q['52-week high'] || stockData?.yearHigh || 0),
            yearLow: parseFloat(q['52-week low'] || stockData?.yearLow || 0),
            currency: 'USD',
            exchange: 'NMS',
            history: [],
            source: 'alpha_vantage'
          };
          source = 'alpha_vantage';
        }
      } catch (e) {
        console.warn(`Alpha Vantage failed for ${symbol}: ${e.message}`);
      }
    }

    // Strategy 3: Finnhub (backup)
    if (!stockData) {
      try {
        const FH_KEY = process.env.FINNHUB_KEY || 'demo';
        const fhUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FH_KEY}`;
        const fhResponse = await fetch(fhUrl);
        const fhData = await fhResponse.json();

        if (fhData.c && fhData.c > 0) {
          stockData = {
            symbol: symbol,
            price: fhData.c,
            prevClose: fhData.pc,
            change: fhData.d,
            changePct: fhData.dp,
            dayHigh: fhData.h,
            dayLow: fhData.l,
            volume: 0,
            marketCap: 0,
            yearHigh: fhData['52WeekHigh'],
            yearLow: fhData['52WeekLow'],
            currency: 'USD',
            exchange: 'NMS',
            history: [],
            source: 'finnhub'
          };
          source = 'finnhub';
        }
      } catch (e) {
        console.warn(`Finnhub failed for ${symbol}: ${e.message}`);
      }
    }

    // All sources failed
    if (!stockData) {
      return res.status(404).json({
        error: `No data available for ${symbol}`,
        sources_tried: ['yahoo', 'alpha_vantage', 'finnhub']
      });
    }

    // Calculate technical indicators
    if (includeIndicators && stockData.history && stockData.history.length > 0) {
      stockData.indicators = calculateIndicators(stockData.history);

      // Calculate buy/sell signals
      stockData.signals = analyzeSignals(stockData.indicators, stockData.price);
    }

    stockData.source = source;
    stockData.timestamp = Date.now();

    // Store in cache
    if (!global.stockCache) global.stockCache = {};
    global.stockCache[cacheKey] = {
      data: stockData,
      timestamp: Date.now()
    };

    console.log(`✓ ${symbol}: $${stockData.price} (${source})`);
    return res.status(200).json(stockData);

  } catch (error) {
    console.error('Stock API Error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

// ============ YAHOO FINANCE FETCHER ============
async function fetchFromYahoo(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  if (!data.chart?.result?.[0]) throw new Error('No data');

  const result = data.chart.result[0];
  const meta = result.meta;
  const adjClose = result.indicators?.adjclose?.[0];
  const quote = result.indicators?.quote?.[0];
  const timestamps = result.timestamp || [];

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

  if (!lastValidClose) throw new Error('No valid price');

  if (previousClose === null) previousClose = lastValidClose;

  // Build history
  const history = [];
  for (let i = 0; i <= lastValidIndex && i < timestamps.length; i++) {
    if (closes[i] && closes[i] > 0) {
      history.push({
        time: timestamps[i],
        open: quote?.open?.[i] || closes[i],
        high: quote?.high?.[i] || closes[i],
        low: quote?.low?.[i] || closes[i],
        close: closes[i],
        volume: quote?.volume?.[i] || 0
      });
    }
  }

  return {
    symbol: symbol,
    name: meta.shortName || meta.symbol || symbol,
    price: lastValidClose,
    prevClose: previousClose,
    change: lastValidClose - previousClose,
    changePct: previousClose > 0 ? ((lastValidClose - previousClose) / previousClose) * 100 : 0,
    dayHigh: meta.regularMarketDayHigh || lastValidClose * 1.02,
    dayLow: meta.regularMarketDayLow || lastValidClose * 0.98,
    volume: meta.regularMarketVolume || 0,
    marketCap: meta.marketCap || 0,
    yearHigh: meta.fiftyTwoWeekHigh || lastValidClose * 1.5,
    yearLow: meta.fiftyTwoWeekLow || lastValidClose * 0.5,
    currency: meta.currency || 'USD',
    exchange: meta.exchangeName || 'NMS',
    history: history,
    source: 'yahoo'
  };
}

// ============ TECHNICAL INDICATORS CALCULATOR ============
function calculateIndicators(history) {
  const closes = history.map(h => h.close);
  const highs = history.map(h => h.high);
  const lows = history.map(h => h.low);
  const volumes = history.map(h => h.volume);

  return {
    // Moving Averages
    ma20: calculateMA(closes, 20),
    ma50: calculateMA(closes, 50),
    ma200: calculateMA(closes, 200),

    // Exponential Moving Averages
    ema12: calculateEMA(closes, 12),
    ema26: calculateEMA(closes, 26),

    // MACD
    macd: calculateMACD(closes),

    // RSI (14 periods)
    rsi: calculateRSI(closes, 14),

    // Bollinger Bands
    bollinger: calculateBollingerBands(closes, 20),

    // Average True Range
    atr: calculateATR(highs, lows, closes, 14),

    // Stochastic
    stochastic: calculateStochastic(highs, lows, closes, 14),

    // Volume analysis
    volumeProfile: calculateVolumeProfile(volumes, closes),

    // Support/Resistance levels
    supportResistance: calculateSupportResistance( highs, lows, closes)
  };
}

function calculateMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);

  if (!ema12 || !ema26) return { value: 0, signal: 0, histogram: 0 };

  const macdLine = ema12 - ema26;

  // Calculate signal line (9-period EMA of MACD)
  // For simplicity, using 9 last values
  const macdValues = [];
  for (let i = 26; i < prices.length; i++) {
    const e12 = calculateEMA(prices.slice(0, i + 1), 12);
    const e26 = calculateEMA(prices.slice(0, i + 1), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }

  const signal = macdValues.length >= 9
    ? calculateEMA(macdValues, 9)
    : macdLine;

  return {
    value: macdLine,
    signal: signal,
    histogram: macdLine - signal
  };
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  // Calculate average gain/loss
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateBollingerBands(prices, period = 20) {
  const ma = calculateMA(prices, period);
  if (!ma || prices.length < period) return { upper: 0, middle: 0, lower: 0 };

  // Calculate standard deviation
  const slice = prices.slice(-period);
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - ma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: ma + (stdDev * 2),
    middle: ma,
    lower: ma - (stdDev * 2),
    bandwidth: ((ma + stdDev * 2) - (ma - stdDev * 2)) / ma * 100
  };
}

function calculateATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return 0;

  let trueRanges = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  // Calculate ATR using smoothed average
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function calculateStochastic(highs, lows, closes, period = 14) {
  if (closes.length < period) return { k: 50, d: 50 };

  const recentCloses = closes.slice(-period);
  const recentHighs = highs.slice(-period);
  const recentLows = lows.slice(-period);

  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const currentClose = closes[closes.length - 1];

  const k = highestHigh === lowestLow
    ? 50
    : ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;

  // %D is 3-period moving average of %K
  const d = k; // Simplified for single value

  return { k: k, d: d };
}

function calculateVolumeProfile(volumes, closes) {
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const currentVolume = volumes[volumes.length - 1] || 0;

  return {
    current: currentVolume,
    average: avgVolume,
    ratio: avgVolume > 0 ? currentVolume / avgVolume : 1,
    trend: currentVolume > avgVolume ? 'high' : currentVolume < avgVolume * 0.7 ? 'low' : 'normal'
  };
}

function calculateSupportResistance(highs, lows, closes) {
  const last20 = closes.slice(-20);
  if (last20.length < 10) return { support: 0, resistance: 0 };

  // Find support (lowest point in recent history)
  const support = Math.min(...last20.slice(-10));

  // Find resistance (highest point in recent history)
  const resistance = Math.max(...last20.slice(-10));

  // Current price distance to levels
  const current = closes[closes.length - 1];

  return {
    support: support,
    resistance: resistance,
    supportDistance: ((current - support) / current) * 100,
    resistanceDistance: ((resistance - current) / current) * 100,
    pivot: (highs.slice(-1)[0] + lows.slice(-1)[0] + current) / 3
  };
}

// ============ BUY/SELL SIGNAL ANALYZER ============
function analyzeSignals(indicators, currentPrice) {
  const signals = {
    overall: 'NEUTRAL', // BUY, SELL, NEUTRAL
    overallScore: 0,    // -100 to +100
    buySignals: [],
    sellSignals: [],
    neutralSignals: [],
    alerts: []
  };

  if (!indicators) return signals;

  // 1. RSI Analysis
  if (indicators.rsi !== undefined) {
    if (indicators.rsi < 30) {
      signals.buySignals.push({ indicator: 'RSI', value: indicators.rsi, signal: 'BUY', reason: '超賣區 (<30)' });
      signals.overallScore += 25;
    } else if (indicators.rsi > 70) {
      signals.sellSignals.push({ indicator: 'RSI', value: indicators.rsi, signal: 'SELL', reason: '超買區 (>70)' });
      signals.overallScore -= 25;
    } else {
      signals.neutralSignals.push({ indicator: 'RSI', value: indicators.rsi, signal: 'NEUTRAL', reason: '中性區域' });
    }
  }

  // 2. MACD Analysis
  if (indicators.macd) {
    if (indicators.macd.histogram > 0 && indicators.macd.histogram > 0.5) {
      signals.buySignals.push({ indicator: 'MACD', value: indicators.macd.histogram, signal: 'BUY', reason: 'MACD 柱狀圖轉正且擴大' });
      signals.overallScore += 20;
    } else if (indicators.macd.histogram < 0 && indicators.macd.histogram < -0.5) {
      signals.sellSignals.push({ indicator: 'MACD', value: indicators.macd.histogram, signal: 'SELL', reason: 'MACD 柱狀圖轉負且擴大' });
      signals.overallScore -= 20;
    } else if (indicators.macd.histogram > 0) {
      signals.neutralSignals.push({ indicator: 'MACD', value: indicators.macd.histogram, signal: 'NEUTRAL', reason: 'MACD 柱狀圖為正但較弱' });
      signals.overallScore += 5;
    } else {
      signals.neutralSignals.push({ indicator: 'MACD', value: indicators.macd.histogram, signal: 'NEUTRAL', reason: 'MACD 柱狀圖為負但較弱' });
      signals.overallScore -= 5;
    }

    // MACD 金叉/死叉
    if (indicators.macd.value > indicators.macd.signal && indicators.macd.value > 0) {
      signals.buySignals.push({ indicator: 'MACD Cross', value: 1, signal: 'BUY', reason: 'MACD 金叉 (多頭信号)' });
      signals.overallScore += 15;
    } else if (indicators.macd.value < indicators.macd.signal && indicators.macd.value < 0) {
      signals.sellSignals.push({ indicator: 'MACD Cross', value: -1, signal: 'SELL', reason: 'MACD 死叉 (空頭信号)' });
      signals.overallScore -= 15;
    }
  }

  // 3. Moving Average Analysis
  if (indicators.ma20 && indicators.ma50) {
    if (currentPrice > indicators.ma20 && indicators.ma20 > indicators.ma50) {
      signals.buySignals.push({ indicator: 'MA Golden Cross', value: 1, signal: 'BUY', reason: 'MA20 > MA50 金叉' });
      signals.overallScore += 15;
    } else if (currentPrice < indicators.ma20 && indicators.ma20 < indicators.ma50) {
      signals.sellSignals.push({ indicator: 'MA Death Cross', value: -1, signal: 'SELL', reason: 'MA20 < MA50 死叉' });
      signals.overallScore -= 15;
    } else if (currentPrice > indicators.ma20) {
      signals.neutralSignals.push({ indicator: 'Price vs MA20', value: currentPrice, signal: 'NEUTRAL', reason: '價格在 MA20 之上' });
      signals.overallScore += 5;
    } else {
      signals.neutralSignals.push({ indicator: 'Price vs MA20', value: currentPrice, signal: 'NEUTRAL', reason: '價格在 MA20 之下' });
      signals.overallScore -= 5;
    }
  }

  // 4. Bollinger Bands Analysis
  if (indicators.bollinger) {
    const { upper, middle, lower } = indicators.bollinger;
    if (upper && lower && middle) {
      const position = (currentPrice - lower) / (upper - lower);

      if (position < 0.2) {
        signals.buySignals.push({ indicator: 'Bollinger', value: position, signal: 'BUY', reason: '觸及布林下軌 (超賣區域)' });
        signals.overallScore += 15;
      } else if (position > 0.8) {
        signals.sellSignals.push({ indicator: 'Bollinger', value: position, signal: 'SELL', reason: '觸及布林上軌 (超買區域)' });
        signals.overallScore -= 15;
      } else if (position > 0.5) {
        signals.neutralSignals.push({ indicator: 'Bollinger', value: position, signal: 'NEUTRAL', reason: '價格高於布林中軌' });
        signals.overallScore += 3;
      } else {
        signals.neutralSignals.push({ indicator: 'Bollinger', value: position, signal: 'NEUTRAL', reason: '價格低於布林中軌' });
        signals.overallScore -= 3;
      }
    }
  }

  // 5. Stochastic Analysis
  if (indicators.stochastic) {
    if (indicators.stochastic.k < 20) {
      signals.buySignals.push({ indicator: 'Stochastic', value: indicators.stochastic.k, signal: 'BUY', reason: '隨機指標超賣 (<20)' });
      signals.overallScore += 10;
    } else if (indicators.stochastic.k > 80) {
      signals.sellSignals.push({ indicator: 'Stochastic', value: indicators.stochastic.k, signal: 'SELL', reason: '隨機指標超買 (>80)' });
      signals.overallScore -= 10;
    } else if (indicators.stochastic.k < 50) {
      signals.neutralSignals.push({ indicator: 'Stochastic', value: indicators.stochastic.k, signal: 'NEUTRAL', reason: '隨機指標低於中線' });
      signals.overallScore -= 2;
    } else {
      signals.neutralSignals.push({ indicator: 'Stochastic', value: indicators.stochastic.k, signal: 'NEUTRAL', reason: '隨機指標高於中線' });
      signals.overallScore += 2;
    }
  }

  // 6. Support/Resistance Analysis
  if (indicators.supportResistance) {
    const { support, resistance } = indicators.supportResistance;
    if (support && resistance && currentPrice) {
      const supportDist = ((currentPrice - support) / currentPrice) * 100;
      const resistDist = ((resistance - currentPrice) / currentPrice) * 100;

      if (supportDist < 3) {
        signals.buySignals.push({ indicator: 'Support', value: supportDist, signal: 'BUY', reason: `靠近支撐位 ${support.toFixed(2)}` });
        signals.overallScore += 10;
      }

      if (resistDist < 3) {
        signals.sellSignals.push({ indicator: 'Resistance', value: resistDist, signal: 'SELL', reason: `接近壓力位 ${resistance.toFixed(2)}` });
        signals.overallScore -= 10;
      }
    }
  }

  // 7. Volume Analysis
  if (indicators.volumeProfile) {
    if (indicators.volumeProfile.trend === 'high') {
      signals.buySignals.push({ indicator: 'Volume', value: indicators.volumeProfile.ratio, signal: 'BUY', reason: '成交量高於平均' });
      signals.overallScore += 8;
    } else if (indicators.volumeProfile.trend === 'low') {
      signals.sellSignals.push({ indicator: 'Volume', value: indicators.volumeProfile.ratio, signal: 'SELL', reason: '成交量低於平均' });
      signals.overallScore -= 5;
    }
  }

  // Determine overall signal
  const totalSignals = signals.buySignals.length + signals.sellSignals.length;

  if (totalSignals > 0) {
    if (signals.overallScore >= 30) {
      signals.overall = 'BUY';
      signals.alerts.push({
        type: 'BUY_ALERT',
        priority: signals.overallScore >= 50 ? 'HIGH' : 'MEDIUM',
        message: `🚀 強烈買入信號！綜合評分: ${signals.overallScore} (${signals.buySignals.length} 個買入信號 vs ${signals.sellSignals.length} 個賣出信號)`
      });
    } else if (signals.overallScore <= -30) {
      signals.overall = 'SELL';
      signals.alerts.push({
        type: 'SELL_ALERT',
        priority: signals.overallScore <= -50 ? 'HIGH' : 'MEDIUM',
        message: `🛑 強烈賣出信號！綜合評分: ${signals.overallScore} (${signals.buySignals.length} 個買入信號 vs ${signals.sellSignals.length} 個賣出信號)`
      });
    } else if (signals.overallScore > 0) {
      signals.overall = 'NEUTRAL_BIAS_UP';
      if (signals.buySignals.length > signals.sellSignals.length) {
        signals.alerts.push({
          type: 'WATCH',
          priority: 'LOW',
          message: `👀 輕微偏多，小心上証。買入: ${signals.buySignals.length} 個，賣出: ${signals.sellSignals.length} 個`
        });
      }
    } else if (signals.overallScore < 0) {
      signals.overall = 'NEUTRAL_BIAS_DOWN';
      if (signals.sellSignals.length > signals.buySignals.length) {
        signals.alerts.push({
          type: 'WATCH',
          priority: 'LOW',
          message: `⚠️ 輕微偏空，注意風險。買入: ${signals.buySignals.length} 個，賣出: ${signals.sellSignals.length} 個`
        });
      }
    } else {
      signals.overall = 'NEUTRAL';
    }
  } else {
    signals.overall = 'NEUTRAL';
  }

  // Add specific alerts for extreme conditions
  if (indicators.rsi && indicators.rsi < 25) {
    signals.alerts.push({
      type: 'EXTREME_BUY',
      priority: 'HIGH',
      message: `💚 RSI 嚴重超賣 (${indicators.rsi.toFixed(1)})！強烈建議關注買入時機`
    });
  }
  if (indicators.rsi && indicators.rsi > 75) {
    signals.alerts.push({
      type: 'EXTREME_SELL',
      priority: 'HIGH',
      message: `💔 RSI 嚴重超買 (${indicators.rsi.toFixed(1)})！建議考慮獲利了結`
    });
  }

  return signals;
}