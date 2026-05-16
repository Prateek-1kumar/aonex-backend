---
name: reference_extraction_quality_sources
description: Curated authoritative URLs for product extraction quality, observability, and ML ops research
metadata:
  type: reference
---

Top sources for production extraction quality + ops research, verified live 2026-05-16:

**E-commerce catalog case studies:**
- Shopify Global Catalogue (multimodal LLM, ICLR 2025): https://shopify.engineering/leveraging-multimodal-llms
- Shopify Evolution of Product Classification (2025): https://shopify.engineering/evolution-product-classification
- Walmart LLMs for catalog management (Dec 2024): https://tech.walmart.com/content/walmart-global-tech/en_us/blog/post/using-llms-to-manage-product-catalogs.html
- Wayfair + Snorkel data-centric AI: https://snorkel.ai/customer-story/wayfair/
- Wayfair Tech Blog (Snorkel partnership): https://www.aboutwayfair.com/careers/tech-blog/accelerating-catalog-tagging-automation-with-snorkels-data-centric-ai-platform-wayfairs-success-story

**Golden / benchmark datasets:**
- MAVE (Google/Amazon, 3M annotations, 1257 categories): https://github.com/google-research-datasets/MAVE
- WDC Products (2,162 entities, 3,259 e-shops, schema.org): https://webdatacommons.org/largescaleproductcorpus/wdc-products/
- WDC Gold Standard for Product Feature Extraction: http://webdatacommons.org/productcorpus/paper/WDC-EC_GS.pdf

**Scraping ops + drift:**
- PromptCloud scraping monitoring guide: https://www.promptcloud.com/blog/web-scraping-monitoring-challenges/
- ProWebScraper breakage analysis (1–2% weekly break rate): https://prowebscraper.com/articles/scraper-breakage
- Zyte best web scraping APIs benchmark: https://www.zyte.com/blog/best-web-scraping-apis-2026/
- Scrapfly bypass success rates by anti-bot vendor: https://scrapfly.io/bypass

**ML observability + calibration:**
- Arize Phoenix / AX (LLM eval): https://arize.com (referenced via Coralogix comparison)
- WhyLabs (open-sourced Apache 2.0 Jan 2025): https://whylabs.ai
- Fiddler AI (governance + drift): https://fiddler.ai
- ICLR 2025 calibration blog post (ECE explainer): https://iclr-blogposts.github.io/2025/blog/calibration/

**Shadow / canary deployment patterns:**
- AWS SageMaker shadow testing: https://aws.amazon.com/blogs/machine-learning/minimize-the-production-impact-of-ml-model-updates-with-amazon-sagemaker-shadow-testing/
- TianPan LLM gradual rollout guide (Apr 2026): https://tianpan.co/blog/2026-04-09-llm-gradual-rollout-shadow-canary-ab-testing

**Observability tooling:**
- Honeycomb high-cardinality docs: https://docs.honeycomb.io/get-started/basics/observability/concepts/high-cardinality
- Shopify Observe platform: https://horovits.medium.com/shopifys-journey-to-planet-scale-observability-9c0b299a04dd

**How to apply:**
- Cite these by URL when producing extraction-quality briefs.
- Shopify and Walmart blogs date-stamp their work; favor 2024–2025 posts for current architecture.
- WDC + MAVE are the only public benchmarks with enough scale for category-by-category eval reference.
