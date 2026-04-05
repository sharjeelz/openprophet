package controllers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"prophet-trader/interfaces"
	"prophet-trader/services"
	"time"

	"github.com/gin-gonic/gin"
)

// IntelligenceController handles AI-powered intelligence operations
type IntelligenceController struct {
	newsService          *services.NewsService
	geminiService        *services.GeminiService
	analysisService      *services.TechnicalAnalysisService
	stockAnalysisService *services.StockAnalysisService
	dataService          interfaces.DataService
	refinitivService     *services.RefinitivService
	twelveDataService    *services.TwelveDataService
}

// NewIntelligenceController creates a new intelligence controller
func NewIntelligenceController(newsService *services.NewsService, geminiService *services.GeminiService, analysisService *services.TechnicalAnalysisService, stockAnalysisService *services.StockAnalysisService, dataService interfaces.DataService) *IntelligenceController {
	return &IntelligenceController{
		newsService:          newsService,
		geminiService:        geminiService,
		analysisService:      analysisService,
		stockAnalysisService: stockAnalysisService,
		dataService:          dataService,
		refinitivService:     services.NewRefinitivService(),
		twelveDataService:    services.NewTwelveDataService(),
	}
}

// AggregateNewsRequest represents a request to aggregate news from multiple sources
type AggregateNewsRequest struct {
	IncludeGoogle        bool     `json:"include_google"`
	IncludeMarketWatch   bool     `json:"include_marketwatch"`
	GoogleTopics         []string `json:"google_topics"`           // BUSINESS, TECHNOLOGY, etc.
	Symbols              []string `json:"symbols"`                 // Stock symbols to search for
	MaxArticlesPerSource int      `json:"max_articles_per_source"` // Default 10
}

// HandleGetCleanedNews aggregates news from multiple sources and returns a cleaned summary
// POST /api/v1/intelligence/cleaned-news
func (ic *IntelligenceController) HandleGetCleanedNews(c *gin.Context) {
	var req AggregateNewsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "Invalid request",
			"details": err.Error(),
		})
		return
	}

	// Set defaults
	if !req.IncludeGoogle && !req.IncludeMarketWatch {
		req.IncludeGoogle = true
		req.IncludeMarketWatch = true
	}
	if req.MaxArticlesPerSource == 0 {
		req.MaxArticlesPerSource = 25
	}

	// Aggregate news from all requested sources
	allNews := make([]services.NewsItem, 0)

	// Fetch from Google News
	if req.IncludeGoogle {
		// Fetch by topics
		for _, topic := range req.GoogleTopics {
			if news, err := ic.newsService.GetGoogleNewsByTopic(topic); err == nil {
				limit := min(len(news), req.MaxArticlesPerSource)
				allNews = append(allNews, news[:limit]...)
			}
		}

		// Fetch by symbols
		for _, symbol := range req.Symbols {
			if news, err := ic.newsService.GetGoogleNewsSearch(symbol); err == nil {
				limit := min(len(news), req.MaxArticlesPerSource)
				allNews = append(allNews, news[:limit]...)
			}
		}

		// If no specific topics or symbols, get general business news
		if len(req.GoogleTopics) == 0 && len(req.Symbols) == 0 {
			if news, err := ic.newsService.GetGoogleNewsByTopic("BUSINESS"); err == nil {
				limit := min(len(news), req.MaxArticlesPerSource)
				allNews = append(allNews, news[:limit]...)
			}
		}
	}

	// Fetch from MarketWatch
	if req.IncludeMarketWatch {
		if news, err := ic.newsService.GetAllMarketWatchNews(); err == nil {
			limit := min(len(news), req.MaxArticlesPerSource*4) // Get from all 4 feeds
			allNews = append(allNews, news[:limit]...)
		}
	}

	if len(allNews) == 0 {
		c.JSON(http.StatusOK, gin.H{
			"message":      "No news found",
			"cleaned_news": nil,
		})
		return
	}

	// Clean the news using Gemini
	cleanedNews, err := ic.geminiService.CleanNewsForTrading(allNews)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to clean news",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"cleaned_news":      cleanedNews,
		"raw_article_count": len(allNews),
	})
}

// HandleGetQuickMarketIntelligence provides a quick market overview
// GET /api/v1/intelligence/quick-market
func (ic *IntelligenceController) HandleGetQuickMarketIntelligence(c *gin.Context) {
	// Get latest from MarketWatch (fastest, most relevant)
	allNews := make([]services.NewsItem, 0)

	// Get top stories
	if news, err := ic.newsService.GetMarketWatchTopStories(); err == nil {
		allNews = append(allNews, news[:min(5, len(news))]...)
	}

	// Get bulletins
	if news, err := ic.newsService.GetMarketWatchBulletins(); err == nil {
		allNews = append(allNews, news[:min(5, len(news))]...)
	}

	// Get market pulse
	if news, err := ic.newsService.GetMarketWatchMarketPulse(); err == nil {
		allNews = append(allNews, news[:min(5, len(news))]...)
	}

	if len(allNews) == 0 {
		c.JSON(http.StatusOK, gin.H{
			"message": "No news found",
		})
		return
	}

	// Clean the news
	cleanedNews, err := ic.geminiService.CleanNewsForTrading(allNews)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to generate intelligence",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, cleanedNews)
}

// HandleAnalyzeStock provides comprehensive analysis for a single stock
// GET /api/v1/intelligence/analyze/:symbol
func (ic *IntelligenceController) HandleAnalyzeStock(c *gin.Context) {
	symbol := c.Param("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "symbol required",
		})
		return
	}

	// Add timeout to prevent indefinite hangs
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	analysis, err := ic.stockAnalysisService.AnalyzeStock(ctx, symbol)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to analyze stock",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, analysis)
}

// AnalyzeStocksRequest represents a request to analyze multiple stocks
type AnalyzeStocksRequest struct {
	Symbols []string `json:"symbols" binding:"required"`
}

// HandleAnalyzeMultipleStocks provides comprehensive analysis for multiple stocks
// POST /api/v1/intelligence/analyze-multiple
func (ic *IntelligenceController) HandleAnalyzeMultipleStocks(c *gin.Context) {
	var req AnalyzeStocksRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "Invalid request",
			"details": err.Error(),
		})
		return
	}

	if len(req.Symbols) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "At least one symbol required",
		})
		return
	}

	// Add timeout to prevent indefinite hangs
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	analyses, err := ic.stockAnalysisService.AnalyzeStocks(ctx, req.Symbols)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to analyze stocks",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"analyses": analyses,
		"count":    len(analyses),
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ── Saudi Market Research ─────────────────────────────────────────────

var saudiTickers = []string{
	"2222.SR", // Saudi Aramco
	"1120.SR", // Al Rajhi Bank
	"7010.SR", // STC
	"1180.SR", // Saudi National Bank
	"2010.SR", // SABIC
	"1211.SR", // Maaden
	"2380.SR", // Petro Rabigh
	"4200.SR", // SACO
	"KSA",     // iShares MSCI Saudi Arabia ETF (US-traded proxy)
}

// SaudiQuote holds a live quote for a Saudi ticker
type SaudiQuote struct {
	Symbol    string  `json:"symbol"`
	Name      string  `json:"name"`
	Price     float64 `json:"price"`
	ChangePct float64 `json:"change_pct"`
	Currency  string  `json:"currency"`
	State     string  `json:"market_state"`
}

// fetchYahooQuote fetches a single quote from Yahoo Finance
func fetchYahooQuote(client *http.Client, ticker string) SaudiQuote {
	q := SaudiQuote{Symbol: ticker}
	url := fmt.Sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s", ticker)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return q
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := client.Do(req)
	if err != nil {
		return q
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return q
	}
	var result struct {
		Chart struct {
			Result []struct {
				Meta struct {
					ShortName                 string  `json:"shortName"`
					RegularMarketPrice        float64 `json:"regularMarketPrice"`
					RegularMarketChangePercent float64 `json:"regularMarketChangePercent"`
					Currency                  string  `json:"currency"`
					MarketState               string  `json:"marketState"`
				} `json:"meta"`
			} `json:"result"`
		} `json:"chart"`
	}
	if err := json.Unmarshal(body, &result); err != nil || len(result.Chart.Result) == 0 {
		return q
	}
	meta := result.Chart.Result[0].Meta
	q.Name = meta.ShortName
	q.Price = meta.RegularMarketPrice
	q.ChangePct = meta.RegularMarketChangePercent
	q.Currency = meta.Currency
	q.State = meta.MarketState
	return q
}

// HandleGetSaudiNews returns raw Saudi market news (Argaam + Arab News)
// GET /api/v1/intelligence/saudi-news
func (ic *IntelligenceController) HandleGetSaudiNews(c *gin.Context) {
	news, err := ic.newsService.GetAllSaudiNews()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"news":    news,
		"count":   len(news),
		"market":  "Saudi (Tadawul)",
	})
}

// HandleGetSaudiMarketIntelligence provides AI-powered Saudi market intelligence
// GET /api/v1/intelligence/saudi-market
func (ic *IntelligenceController) HandleGetSaudiMarketIntelligence(c *gin.Context) {
	// Bare symbol list (no suffix) — Refinitiv adds .SE, Twelve Data uses exchange=Tadawul
	bareSymbols := []string{"2222", "1120", "7010", "1180", "2010", "1211", "2380", "4200"}

	// Fetch live quotes from Refinitiv
	var quotes interface{}
	if ic.refinitivService.IsConfigured() {
		liveQuotes, err := ic.refinitivService.GetLiveQuotes(bareSymbols)
		if err == nil {
			quotes = liveQuotes
		} else {
			quotes = gin.H{"error": err.Error()}
		}
	} else {
		quotes = gin.H{"error": "Refinitiv not configured"}
	}

	// Fetch technicals from Twelve Data
	var technicals interface{}
	if ic.twelveDataService.IsConfigured() {
		techs := ic.twelveDataService.GetTechnicalsForAll(bareSymbols, "1h")
		technicals = techs
	}

	// Fetch Saudi news
	news, _ := ic.newsService.GetAllSaudiNews()

	// Clean news via Gemini
	var intelligence interface{}
	if len(news) > 0 {
		cleaned, err := ic.geminiService.CleanNewsForTrading(news[:min(20, len(news))])
		if err == nil {
			intelligence = cleaned
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"market":       "Saudi (Tadawul)",
		"trading_days": "Sunday–Thursday",
		"hours_ast":    "10:00–15:00",
		"hours_utc":    "07:00–12:00",
		"quotes":       quotes,
		"technicals":   technicals,
		"intelligence": intelligence,
		"tickers":      saudiTickers,
	})
}

// HandleGetSaudiTechnicals returns technical indicators for a specific Saudi stock
// GET /api/v1/intelligence/saudi-technicals/:symbol?interval=1h
func (ic *IntelligenceController) HandleGetSaudiTechnicals(c *gin.Context) {
	symbol := c.Param("symbol")
	interval := c.DefaultQuery("interval", "1h")

	if !ic.twelveDataService.IsConfigured() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Twelve Data not configured — set TWELVE_DATA_API_KEY"})
		return
	}

	tech, err := ic.twelveDataService.GetTechnicals(symbol, interval)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, tech)
}
