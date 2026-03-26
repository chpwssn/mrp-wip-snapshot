.PHONY: collect report html publish clean

# Full collection + report
collect:
	yarn tsx src/collect.ts --output report.md

# Generate printable HTML from report.md
html: report.md style.css
	@echo "Generating report.html..."
	@echo '<!DOCTYPE html>' > report.html
	@echo '<html lang="en"><head>' >> report.html
	@echo '<meta charset="utf-8">' >> report.html
	@echo '<meta name="viewport" content="width=device-width">' >> report.html
	@echo '<title>WIP Shortage Snapshot v'"$$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json')).version)")"' — '"$$(TZ=America/Denver date '+%Y-%m-%d %H:%M %Z')"'</title>' >> report.html
	@echo '<style>' >> report.html
	@cat style.css >> report.html
	@echo '</style></head><body>' >> report.html
	@npx marked report.md --gfm >> report.html
	@echo '</body></html>' >> report.html
	@echo "Done → report.html"

# Collect, generate HTML, and publish in one step
all: collect html

# Publish report.html to reports/ with snapshot number, update index.html symlink
publish: report.html
	@mkdir -p reports
	@SNAP=$$(sqlite3 data/mrp.db "SELECT MAX(id) FROM snapshots"); \
	if [ -z "$$SNAP" ]; then echo "No snapshot found in database"; exit 1; fi; \
	DEST="reports/report_$${SNAP}.html"; \
	cp report.html "$$DEST"; \
	cp help.html reports/help.html; \
	cd reports && ln -sf "report_$${SNAP}.html" index.html; \
	echo "Published → $$DEST (index.html → report_$${SNAP}.html)"

# Clean generated files (not the database)
clean:
	rm -f report.md report.html
