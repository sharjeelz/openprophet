package services

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// TwelveDataService fetches technical indicators from Twelve Data API
type TwelveDataService struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// SaudiTechnicals holds technical indicators for a Saudi stock
type SaudiTechnicals struct {
	Symbol   string  `json:"symbol"`
	Interval string  `json:"interval"`
	RSI      float64 `json:"rsi"`
	MACD     float64 `json:"macd"`
	MACDSignal float64 `json:"macd_signal"`
	MACDHist float64 `json:"macd_hist"`
	EMA20    float64 `json:"ema20"`
	EMA50    float64 `json:"ema50"`
	BBUpper  float64 `json:"bb_upper"`
	BBMiddle float64 `json:"bb_middle"`
	BBLower  float64 `json:"bb_lower"`
	ATR      float64 `json:"atr"`
	Trend    string  `json:"trend"`   // BULLISH / BEARISH / NEUTRAL
	Signal   string  `json:"signal"`  // BUY / SELL / HOLD
	Error    string  `json:"error,omitempty"`
}

// NewTwelveDataService creates a new Twelve Data service
func NewTwelveDataService() *TwelveDataService {
	return &TwelveDataService{
		baseURL: getEnvOrDefault("TWELVE_DATA_URL", "https://api.twelvedata.com"),
		apiKey:  os.Getenv("TWELVE_DATA_API_KEY"),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// IsConfigured returns true if API key is set
func (t *TwelveDataService) IsConfigured() bool {
	return t.apiKey != ""
}

// GetTechnicals fetches key technical indicators for a Saudi stock
// symbol: bare number like "2222", exchange: "Tadawul", interval: "1h" or "1day"
func (t *TwelveDataService) GetTechnicals(symbol, interval string) (*SaudiTechnicals, error) {
	tech := &SaudiTechnicals{Symbol: symbol, Interval: interval}

	rsi, err := t.fetchRSI(symbol, interval)
	if err == nil {
		tech.RSI = rsi
	}

	macd, sig, hist, err := t.fetchMACD(symbol, interval)
	if err == nil {
		tech.MACD = macd
		tech.MACDSignal = sig
		tech.MACDHist = hist
	}

	ema20, err := t.fetchEMA(symbol, interval, 20)
	if err == nil {
		tech.EMA20 = ema20
	}

	ema50, err := t.fetchEMA(symbol, interval, 50)
	if err == nil {
		tech.EMA50 = ema50
	}

	upper, mid, lower, err := t.fetchBBands(symbol, interval)
	if err == nil {
		tech.BBUpper = upper
		tech.BBMiddle = mid
		tech.BBLower = lower
	}

	atr, err := t.fetchATR(symbol, interval)
	if err == nil {
		tech.ATR = atr
	}

	// Derive trend and signal
	tech.Trend, tech.Signal = deriveTrendSignal(tech)

	return tech, nil
}

// GetTechnicalsForAll fetches technicals for multiple Saudi tickers
func (t *TwelveDataService) GetTechnicalsForAll(symbols []string, interval string) []SaudiTechnicals {
	results := make([]SaudiTechnicals, 0, len(symbols))
	for _, sym := range symbols {
		tech, err := t.GetTechnicals(sym, interval)
		if err != nil {
			results = append(results, SaudiTechnicals{Symbol: sym, Error: err.Error()})
			continue
		}
		results = append(results, *tech)
	}
	return results
}

func (t *TwelveDataService) fetchRSI(symbol, interval string) (float64, error) {
	url := fmt.Sprintf("%s/rsi?symbol=%s&interval=%s&exchange=Tadawul&apikey=%s&outputsize=1",
		t.baseURL, symbol, interval, t.apiKey)
	var resp struct {
		Values []struct {
			RSI string `json:"rsi"`
		} `json:"values"`
	}
	if err := t.fetch(url, &resp); err != nil {
		return 0, err
	}
	if len(resp.Values) == 0 {
		return 0, fmt.Errorf("no RSI data")
	}
	var v float64
	fmt.Sscanf(resp.Values[0].RSI, "%f", &v)
	return v, nil
}

func (t *TwelveDataService) fetchMACD(symbol, interval string) (float64, float64, float64, error) {
	url := fmt.Sprintf("%s/macd?symbol=%s&interval=%s&exchange=Tadawul&apikey=%s&outputsize=1",
		t.baseURL, symbol, interval, t.apiKey)
	var resp struct {
		Values []struct {
			MACD      string `json:"macd"`
			MACDSignal string `json:"macd_signal"`
			MACDHist  string `json:"macd_hist"`
		} `json:"values"`
	}
	if err := t.fetch(url, &resp); err != nil {
		return 0, 0, 0, err
	}
	if len(resp.Values) == 0 {
		return 0, 0, 0, fmt.Errorf("no MACD data")
	}
	var macd, sig, hist float64
	fmt.Sscanf(resp.Values[0].MACD, "%f", &macd)
	fmt.Sscanf(resp.Values[0].MACDSignal, "%f", &sig)
	fmt.Sscanf(resp.Values[0].MACDHist, "%f", &hist)
	return macd, sig, hist, nil
}

func (t *TwelveDataService) fetchEMA(symbol, interval string, period int) (float64, error) {
	url := fmt.Sprintf("%s/ema?symbol=%s&interval=%s&exchange=Tadawul&time_period=%d&apikey=%s&outputsize=1",
		t.baseURL, symbol, interval, period, t.apiKey)
	var resp struct {
		Values []struct {
			EMA string `json:"ema"`
		} `json:"values"`
	}
	if err := t.fetch(url, &resp); err != nil {
		return 0, err
	}
	if len(resp.Values) == 0 {
		return 0, fmt.Errorf("no EMA data")
	}
	var v float64
	fmt.Sscanf(resp.Values[0].EMA, "%f", &v)
	return v, nil
}

func (t *TwelveDataService) fetchBBands(symbol, interval string) (float64, float64, float64, error) {
	url := fmt.Sprintf("%s/bbands?symbol=%s&interval=%s&exchange=Tadawul&apikey=%s&outputsize=1",
		t.baseURL, symbol, interval, t.apiKey)
	var resp struct {
		Values []struct {
			Upper  string `json:"upper_band"`
			Middle string `json:"middle_band"`
			Lower  string `json:"lower_band"`
		} `json:"values"`
	}
	if err := t.fetch(url, &resp); err != nil {
		return 0, 0, 0, err
	}
	if len(resp.Values) == 0 {
		return 0, 0, 0, fmt.Errorf("no BBands data")
	}
	var upper, mid, lower float64
	fmt.Sscanf(resp.Values[0].Upper, "%f", &upper)
	fmt.Sscanf(resp.Values[0].Middle, "%f", &mid)
	fmt.Sscanf(resp.Values[0].Lower, "%f", &lower)
	return upper, mid, lower, nil
}

func (t *TwelveDataService) fetchATR(symbol, interval string) (float64, error) {
	url := fmt.Sprintf("%s/atr?symbol=%s&interval=%s&exchange=Tadawul&apikey=%s&outputsize=1",
		t.baseURL, symbol, interval, t.apiKey)
	var resp struct {
		Values []struct {
			ATR string `json:"atr"`
		} `json:"values"`
	}
	if err := t.fetch(url, &resp); err != nil {
		return 0, err
	}
	if len(resp.Values) == 0 {
		return 0, fmt.Errorf("no ATR data")
	}
	var v float64
	fmt.Sscanf(resp.Values[0].ATR, "%f", &v)
	return v, nil
}

func (t *TwelveDataService) fetch(url string, dest interface{}) error {
	resp, err := t.httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	// Check for API error
	var errResp struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &errResp) == nil && errResp.Status == "error" {
		return fmt.Errorf("twelve data: %s", errResp.Message)
	}
	return json.Unmarshal(body, dest)
}

// deriveTrendSignal generates a simple trend/signal from indicators
func deriveTrendSignal(t *SaudiTechnicals) (string, string) {
	bullish := 0
	bearish := 0

	if t.RSI > 0 {
		if t.RSI > 60 {
			bullish++
		} else if t.RSI < 40 {
			bearish++
		}
	}
	if t.MACDHist > 0 {
		bullish++
	} else if t.MACDHist < 0 {
		bearish++
	}
	if t.EMA20 > 0 && t.EMA50 > 0 {
		if t.EMA20 > t.EMA50 {
			bullish++
		} else {
			bearish++
		}
	}

	trend := "NEUTRAL"
	signal := "HOLD"
	if bullish >= 2 {
		trend = "BULLISH"
		signal = "BUY"
	} else if bearish >= 2 {
		trend = "BEARISH"
		signal = "SELL"
	}
	return trend, signal
}
