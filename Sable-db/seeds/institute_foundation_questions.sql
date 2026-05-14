-- Sable Institute — Foundation MCQ seed.
--
-- A minimum-viable bank of 20 questions covering the Foundation level
-- (terminal navigation, command basics, reading outputs). The Foundation
-- exam picks 60 questions per attempt; the bank should grow to >200
-- before launch so the same candidate doesn't see the same set on a
-- retry. Treat this seed as starter scaffolding, not a final exam.
--
-- Apply once after the gateway schema is loaded:
--   psql -f Sable-db/seeds/institute_foundation_questions.sql
--
-- Re-running is safe (UNIQUE id PK), but keep this seed as the
-- canonical starter and append new rows via migration scripts rather
-- than rewriting here.

INSERT INTO gateway.exam_questions (level, prompt, options, correct_key, category) VALUES
  ('foundation',
   'Which Sable command runs a Monte Carlo simulation against a target?',
   '[{"key":"a","text":"/montecarlo @portfolio"},{"key":"b","text":"/mc-run @portfolio"},{"key":"c","text":"/simulate portfolio"},{"key":"d","text":"/risk @portfolio --mc"}]'::jsonb,
   'a', 'commands'),

  ('foundation',
   'A 95% one-day VaR of £100,000 means:',
   '[{"key":"a","text":"You can lose at most £100,000 tomorrow."},{"key":"b","text":"There is a 5% chance you lose more than £100,000 tomorrow."},{"key":"c","text":"The portfolio is up 95% of the time."},{"key":"d","text":"Tomorrow''s gain will exceed £100,000."}]'::jsonb,
   'b', 'risk'),

  ('foundation',
   'Sharpe ratio is defined as:',
   '[{"key":"a","text":"Return divided by maximum drawdown"},{"key":"b","text":"Excess return divided by standard deviation of returns"},{"key":"c","text":"Total return divided by years held"},{"key":"d","text":"Alpha divided by beta"}]'::jsonb,
   'b', 'quant'),

  ('foundation',
   'In Sable, the @portfolio target refers to:',
   '[{"key":"a","text":"All holdings in the active workspace"},{"key":"b","text":"The active client''s aggregated cross-module portfolio"},{"key":"c","text":"Only the equity holdings"},{"key":"d","text":"The user''s personal watchlist"}]'::jsonb,
   'b', 'commands'),

  ('foundation',
   'Which is NOT a Sable module?',
   '[{"key":"a","text":"S&C"},{"key":"b","text":"Property"},{"key":"c","text":"FX-Forwards"},{"key":"d","text":"Alternatives"}]'::jsonb,
   'c', 'product'),

  ('foundation',
   'Mean-variance optimisation requires:',
   '[{"key":"a","text":"Expected returns and a covariance matrix"},{"key":"b","text":"Only historical returns"},{"key":"c","text":"Only the Sharpe ratio"},{"key":"d","text":"Black-Litterman views"}]'::jsonb,
   'a', 'quant'),

  ('foundation',
   'The Black-Litterman model combines:',
   '[{"key":"a","text":"Historical returns with technical indicators"},{"key":"b","text":"Market equilibrium implied returns with investor views"},{"key":"c","text":"Two independent Sharpe ratios"},{"key":"d","text":"Real and risk-neutral measures"}]'::jsonb,
   'b', 'quant'),

  ('foundation',
   'In Sable, the workspace is best described as:',
   '[{"key":"a","text":"A read-only dashboard panel"},{"key":"b","text":"A Notion-style companion with widgets backed by live module data"},{"key":"c","text":"The settings menu"},{"key":"d","text":"The chatbot history"}]'::jsonb,
   'b', 'product'),

  ('foundation',
   'Walk-forward backtesting differs from a naive backtest because it:',
   '[{"key":"a","text":"Uses higher-frequency data"},{"key":"b","text":"Re-fits the model on a rolling window of past data"},{"key":"c","text":"Doesn''t account for transaction costs"},{"key":"d","text":"Uses Monte Carlo paths instead of historical returns"}]'::jsonb,
   'b', 'quant'),

  ('foundation',
   'Maximum drawdown measures:',
   '[{"key":"a","text":"The largest peak-to-trough decline in portfolio value"},{"key":"b","text":"The average daily loss"},{"key":"c","text":"The standard deviation of returns"},{"key":"d","text":"The 99th-percentile loss"}]'::jsonb,
   'a', 'risk'),

  ('foundation',
   'A portfolio beta of 1.2 implies:',
   '[{"key":"a","text":"The portfolio loses money 20% faster than the market"},{"key":"b","text":"For a 1% market move, the portfolio moves 1.2% on average"},{"key":"c","text":"The portfolio has 20% more diversification"},{"key":"d","text":"The Sharpe ratio is 1.2"}]'::jsonb,
   'b', 'quant'),

  ('foundation',
   'CVaR (Conditional VaR) is:',
   '[{"key":"a","text":"The expected loss conditional on being in the worst 5% of outcomes"},{"key":"b","text":"The probability of a 95% loss"},{"key":"c","text":"The maximum drawdown"},{"key":"d","text":"The Sharpe ratio at 95% confidence"}]'::jsonb,
   'a', 'risk'),

  ('foundation',
   'In Sable, /backtest @portfolio --years 5 by default:',
   '[{"key":"a","text":"Backtests against the most recent 5 years of data"},{"key":"b","text":"Backtests against the first 5 years of data"},{"key":"c","text":"Runs 5 Monte Carlo simulations"},{"key":"d","text":"Backtests against a 5-year-old portfolio snapshot"}]'::jsonb,
   'a', 'commands'),

  ('foundation',
   'The S&C module covers:',
   '[{"key":"a","text":"Stocks and commodities"},{"key":"b","text":"Securities and contracts"},{"key":"c","text":"Stocks and credit"},{"key":"d","text":"Spot and crypto"}]'::jsonb,
   'a', 'product'),

  ('foundation',
   'Which is true about Sable property valuations?',
   '[{"key":"a","text":"Real-time market prices like equities"},{"key":"b","text":"Periodic AVM estimates derived from Land Registry data"},{"key":"c","text":"Manual entry only — no automation"},{"key":"d","text":"Bloomberg-sourced indicative prices"}]'::jsonb,
   'b', 'product'),

  ('foundation',
   'A factor model decomposes returns into:',
   '[{"key":"a","text":"Random walks"},{"key":"b","text":"Systematic factor exposures and idiosyncratic risk"},{"key":"c","text":"Bull and bear regimes"},{"key":"d","text":"Long and short legs"}]'::jsonb,
   'b', 'quant'),

  ('foundation',
   'A 10-bps annual fee on £10M AUM equals:',
   '[{"key":"a","text":"£100"},{"key":"b","text":"£1,000"},{"key":"c","text":"£10,000"},{"key":"d","text":"£100,000"}]'::jsonb,
   'c', 'finance'),

  ('foundation',
   'Annual to monthly compounded conversion of 12% annual is approximately:',
   '[{"key":"a","text":"1.00% per month"},{"key":"b","text":"0.949% per month"},{"key":"c","text":"1.25% per month"},{"key":"d","text":"12.00% per month"}]'::jsonb,
   'b', 'finance'),

  ('foundation',
   'In Sable, /yield @holding:GB00B... returns:',
   '[{"key":"a","text":"The yield-to-maturity of a bond holding"},{"key":"b","text":"The dividend yield of an equity holding"},{"key":"c","text":"The rental yield of a property holding"},{"key":"d","text":"Whichever applies based on the holding''s asset class"}]'::jsonb,
   'd', 'commands'),

  ('foundation',
   'The Sable terminal''s @watchlist:tech target means:',
   '[{"key":"a","text":"The tech sector of the market overall"},{"key":"b","text":"A user-defined watchlist named \"tech\""},{"key":"c","text":"All holdings tagged tech"},{"key":"d","text":"The NASDAQ 100"}]'::jsonb,
   'b', 'commands');
