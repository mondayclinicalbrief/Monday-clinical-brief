const { DateTime } = require("luxon");

module.exports = function(eleventyConfig) {

  // ── Pass-through copies (existing static files) ──
  eleventyConfig.addPassthroughCopy("index.html");
  eleventyConfig.addPassthroughCopy("welcome.html");
  eleventyConfig.addPassthroughCopy("privacy.html");
  eleventyConfig.addPassthroughCopy("terms.html");
  eleventyConfig.addPassthroughCopy("_redirects");
  eleventyConfig.addPassthroughCopy("netlify");
  eleventyConfig.addPassthroughCopy("admin");
  eleventyConfig.addPassthroughCopy("assets");

  // ── Date filters ──
  eleventyConfig.addFilter("readableDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj, { zone: "utc" }).toFormat("d LLLL yyyy");
  });

  eleventyConfig.addFilter("isoDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj, { zone: "utc" }).toISO();
  });

  // ── Reading time filter ──
  eleventyConfig.addFilter("readingTime", (content) => {
    if (!content) return "5 min read";
    // Strip HTML tags for more accurate word count
    const text = String(content).replace(/<[^>]+>/g, '');
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    if (words < 50) return "5 min read"; // fallback for short strings like descriptions
    const mins = Math.ceil(words / 220);
    return `${mins} min read`;
  });

  // ── Blog post collection ──
  eleventyConfig.addCollection("posts", function(collectionApi) {
    return collectionApi.getFilteredByGlob("blog/**/*.md").sort((a, b) => {
      return b.date - a.date;
    });
  });

  // ── Cluster collections ──
  eleventyConfig.addCollection("cluster1", function(collectionApi) {
    return collectionApi.getFilteredByGlob("blog/medical-journal-digest/**/*.md").sort((a, b) => b.date - a.date);
  });

  eleventyConfig.addCollection("cluster2", function(collectionApi) {
    return collectionApi.getFilteredByGlob("blog/cpd-reading-tool/**/*.md").sort((a, b) => b.date - a.date);
  });

  eleventyConfig.addCollection("cluster3", function(collectionApi) {
    return collectionApi.getFilteredByGlob("blog/journal-summary-subscription/**/*.md").sort((a, b) => b.date - a.date);
  });

  // ── Markdown config with anchor links ──
  let markdownIt = require("markdown-it");
  let markdownItAnchor = require("markdown-it-anchor");
  let mdOptions = { html: true, breaks: false, linkify: true };
  let mdLib = markdownIt(mdOptions).use(markdownItAnchor, {
    permalink: false,
    level: [2, 3]
  });
  eleventyConfig.setLibrary("md", mdLib);

  return {
    dir: {
      input: ".",
      includes: "_includes",
      output: "dist"
    },
    templateFormats: ["md", "njk"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
};
