package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

// RefinitivService handles live Saudi market data from Refinitiv RKD API
type RefinitivService struct {
	baseURL    string
	appID      string
	username   string
	password   string
	httpClient *http.Client
	token      string
	tokenExp   time.Time
	mu         sync.Mutex
}

// SaudiLiveQuote holds a live quote from Refinitiv
type SaudiLiveQuote struct {
	Symbol    string  `json:"symbol"`
	RIC       string  `json:"ric"`
	Name      string  `json:"name"`
	Price     float64 `json:"price"`
	Open      float64 `json:"open"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Volume    float64 `json:"volume"`
	ChangePct float64 `json:"change_pct"`
	Change    float64 `json:"change"`
	Currency  string  `json:"currency"`
	Timestamp string  `json:"timestamp"`
	Status    int     `json:"status"`
}

// NewRefinitivService creates a new Refinitiv service
func NewRefinitivService() *RefinitivService {
	return &RefinitivService{
		baseURL:  getEnvOrDefault("REFINITIV_URL", "https://api.rkd.refinitiv.com/api"),
		appID:    os.Getenv("REFINITIV_APP_ID"),
		username: os.Getenv("REFINITIV_USERNAME"),
		password: os.Getenv("REFINITIV_PASSWORD"),
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// IsConfigured returns true if Refinitiv credentials are set
func (r *RefinitivService) IsConfigured() bool {
	return r.appID != "" && r.username != "" && r.password != ""
}

// getToken returns a valid auth token, refreshing if expired
func (r *RefinitivService) getToken() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.token != "" && time.Now().Before(r.tokenExp) {
		return r.token, nil
	}

	url := r.baseURL + "/TokenManagement/TokenManagement.svc/REST/Anonymous/TokenManagement_1/CreateServiceToken_1"

	body := map[string]interface{}{
		"CreateServiceToken_Request_1": map[string]interface{}{
			"ApplicationID": r.appID,
			"Username":      r.username,
			"Password":      r.password,
		},
	}

	resp, err := r.doRequest("POST", url, "", body)
	if err != nil {
		return "", fmt.Errorf("refinitiv auth failed: %w", err)
	}

	// Debug: log raw response keys
	fmt.Printf("[refinitiv-debug] auth response keys: %v\n", func() []string {
		keys := make([]string, 0, len(resp))
		for k := range resp {
			keys = append(keys, k)
		}
		return keys
	}())

	token, ok := getNestedString(resp, "CreateServiceToken_Response_1", "Token")
	if !ok || token == "" {
		// Log full response for diagnosis
		if b, jerr := json.Marshal(resp); jerr == nil {
			fmt.Printf("[refinitiv-debug] full auth response: %s\n", string(b))
		}
		return "", fmt.Errorf("refinitiv: no token in response")
	}

	expStr, _ := getNestedString(resp, "CreateServiceToken_Response_1", "Expiration")
	if expStr != "" {
		if exp, err := time.Parse(time.RFC3339, expStr); err == nil {
			r.tokenExp = exp.Add(-30 * time.Second) // refresh 30s early
		}
	} else {
		r.tokenExp = time.Now().Add(23 * time.Hour)
	}

	r.token = token
	return token, nil
}

// GetLiveQuotes fetches live quotes for a list of Saudi stock symbols
// symbols should be bare numbers like ["2222", "1120"] — .SE suffix added automatically
func (r *RefinitivService) GetLiveQuotes(symbols []string) ([]SaudiLiveQuote, error) {
	token, err := r.getToken()
	if err != nil {
		return nil, err
	}

	rics := make([]string, len(symbols))
	for i, s := range symbols {
		rics[i] = s + ".SE"
	}

	url := r.baseURL + "/QuoteLists/QuoteLists.svc/REST/QuoteLists_1/GetSimpleData_2"
	body := map[string]interface{}{
		"GetSimpleData_Request_2": map[string]interface{}{
			"RICs": map[string]interface{}{
				"RIC": rics,
			},
			"validationMode": "Tolerant",
		},
	}

	resp, err := r.doRequestWithToken("POST", url, token, body)
	if err != nil {
		return nil, fmt.Errorf("refinitiv quotes failed: %w", err)
	}

	items := getNestedSlice(resp, "GetSimpleData_Response_2", "SimpleDataResult", "ItemResponse", "0", "Item")
	quotes := make([]SaudiLiveQuote, 0, len(items))

	for _, item := range items {
		q := SaudiLiveQuote{Currency: "SAR"}

		if m, ok := item.(map[string]interface{}); ok {
			if rk, ok := m["RequestKey"].(map[string]interface{}); ok {
				q.RIC = fmt.Sprintf("%v", rk["Name"])
				// Strip .SE suffix to get bare symbol
				if len(q.RIC) > 3 && q.RIC[len(q.RIC)-3:] == ".SE" {
					q.Symbol = q.RIC[:len(q.RIC)-3]
				} else {
					q.Symbol = q.RIC
				}
			}

			// Parse fields
			if fields, ok := m["Fields"].(map[string]interface{}); ok {
				if fieldList, ok := fields["Field"].([]interface{}); ok {
					for _, f := range fieldList {
						if fm, ok := f.(map[string]interface{}); ok {
							vals := extractValues(fm)
							if len(vals) >= 3 {
								name := fmt.Sprintf("%v", vals[1])
								val := vals[2]
								switch name {
								case "CF_LAST", "TRDPRC_1":
									q.Price = toFloat(val)
								case "CF_NETCHNG":
									q.Change = toFloat(val)
								case "PCTCHNG":
									q.ChangePct = toFloat(val)
								case "CF_OPEN":
									q.Open = toFloat(val)
								case "CF_HIGH":
									q.High = toFloat(val)
								case "CF_LOW":
									q.Low = toFloat(val)
								case "CF_VOLUME":
									q.Volume = toFloat(val)
								case "CF_NAME":
									q.Name = fmt.Sprintf("%v", val)
								case "CF_DATE", "TRADE_DATE":
									q.Timestamp = fmt.Sprintf("%v", val)
								}
							}
						}
					}
				}
			}

			q.Status = 1
			if status, ok := m["Status"].(map[string]interface{}); ok {
				if code := fmt.Sprintf("%v", status["StatusCode"]); code != "0" {
					q.Status = 0
				}
			}
		}

		quotes = append(quotes, q)
	}

	return quotes, nil
}

// doRequest makes an unauthenticated POST request
func (r *RefinitivService) doRequest(method, url, token string, body interface{}) (map[string]interface{}, error) {
	return r.doRequestWithToken(method, url, token, body)
}

// doRequestWithToken makes an authenticated request
func (r *RefinitivService) doRequestWithToken(method, url, token string, body interface{}) (map[string]interface{}, error) {
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(method, url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-Trkd-Auth-Token", token)
		req.Header.Set("X-Trkd-Auth-ApplicationID", r.appID)
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("refinitiv: invalid JSON response: %s", string(respBody[:min(200, len(respBody))]))
	}

	return result, nil
}

// ── Helpers ───────────────────────────────────────────────────────────

func getNestedString(m map[string]interface{}, keys ...string) (string, bool) {
	var cur interface{} = m
	for _, k := range keys {
		if cm, ok := cur.(map[string]interface{}); ok {
			cur = cm[k]
		} else {
			return "", false
		}
	}
	if s, ok := cur.(string); ok {
		return s, true
	}
	return "", false
}

func getNestedSlice(m map[string]interface{}, keys ...string) []interface{} {
	var cur interface{} = m
	for _, k := range keys {
		switch v := cur.(type) {
		case map[string]interface{}:
			cur = v[k]
		case []interface{}:
			if i := parseInt(k); i >= 0 && i < len(v) {
				cur = v[i]
			} else {
				return nil
			}
		default:
			return nil
		}
	}
	if s, ok := cur.([]interface{}); ok {
		return s
	}
	return nil
}

func extractValues(m map[string]interface{}) []interface{} {
	vals := make([]interface{}, 0)
	for i := 0; ; i++ {
		key := fmt.Sprintf("Value_%d", i)
		if v, ok := m[key]; ok {
			vals = append(vals, v)
		} else if i > 5 {
			break
		}
	}
	// Also try array-style
	if v, ok := m["Value"]; ok {
		if arr, ok := v.([]interface{}); ok {
			return arr
		}
	}
	return vals
}

func toFloat(v interface{}) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case string:
		var f float64
		fmt.Sscanf(val, "%f", &f)
		return f
	}
	return 0
}

func parseInt(s string) int {
	var i int
	fmt.Sscanf(s, "%d", &i)
	return i
}
