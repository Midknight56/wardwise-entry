import { AllCommunityModule, ModuleRegistry, createGrid, themeQuartz, type ColDef, type GridApi } from 'ag-grid-community';
import { AgCharts, type AgChartInstance, type AgChartOptions } from 'ag-charts-community';
import { dollars, decimal, integer } from './helpers';

ModuleRegistry.registerModules([AllCommunityModule]);
export interface GridRow {
  ward: number; plan: number; votes: number; return100: number; nonVoters: number;
  cost: number; funded: number; paid: number; change: number; error: number; miss: boolean;
}
export class WardTable {
  readonly api: GridApi<GridRow>;
  private chart?: AgChartInstance;
  private rows: GridRow[] = [];
  constructor(grid: HTMLElement, private chartHost: HTMLElement, select: (id: number) => void) {
    const money = (value: number | undefined) => dollars(value ?? 0);
    const columnDefs: ColDef<GridRow>[] = [
      { field: 'ward', headerName: 'Ward', width: 85, pinned: 'left', cellClass: 'mono' },
      { field: 'plan', headerName: 'Plan $', valueFormatter: p => money(p.value), cellRenderer: (p: { value: number; api: GridApi<GridRow> }) => {
        let max = 0;
        p.api.forEachNodeAfterFilter(node => { max = Math.max(max, node.data?.plan ?? 0); });
        const cell = document.createElement('span'), bar = document.createElement('span'), label = document.createElement('span');
        cell.className = 'plan-cell'; bar.className = 'plan-cell-bar'; label.className = 'plan-cell-label';
        bar.style.width = `${max > 0 ? Math.max(0, p.value ?? 0) / max * 100 : 0}%`;
        bar.setAttribute('aria-hidden', 'true'); label.textContent = money(p.value);
        cell.appendChild(bar); cell.appendChild(label); return cell;
      } },
      { field: 'votes', headerName: 'Expected votes', valueFormatter: p => decimal(p.value ?? 0), width: 150, headerTooltip: 'Assumption: model estimate, not a promised result' },
      { field: 'return100', headerName: 'Votes / $100', sort: 'desc', valueFormatter: p => decimal(p.value ?? 0, 2), width: 145, headerTooltip: 'Assumption: marginal return at current spend; unopened wards include setup' },
      { field: 'nonVoters', headerName: 'Non voters', valueFormatter: p => integer(p.value ?? 0), width: 135 },
      { field: 'cost', headerName: 'Cost / contact', valueFormatter: p => dollars(p.value ?? 0, true), width: 155, headerTooltip: 'Assumption: $2.30 to $2.60 per contact' },
      { field: 'funded', headerName: 'Funded $', valueFormatter: p => money(p.value) },
      { field: 'paid', headerName: 'Paid $', valueFormatter: p => money(p.value) },
      { field: 'change', headerName: 'Turnout change', valueFormatter: p => (p.value > 0 ? '+' : '') + decimal(p.value ?? 0) + ' pt', width: 160, headerTooltip: '2023 turnout minus 2019 turnout, in percentage points' },
      { field: 'error', headerName: 'Error (points)', valueFormatter: p => (p.value > 0 ? '+' : '') + decimal(p.value ?? 0), width: 145 },
      { field: 'miss', headerName: 'Miss', width: 85, cellRenderer: (p: { value: boolean }) => {
        const dot = document.createElement('span');
        dot.className = p.value ? 'miss-dot' : 'no-miss'; dot.textContent = p.value ? '●' : '·';
        dot.setAttribute('aria-label', p.value ? 'Miss' : 'No miss'); return dot;
      } },
    ];
    this.api = createGrid<GridRow>(grid, {
      theme: themeQuartz.withParams({ backgroundColor: '#F3EFE6', foregroundColor: '#1E2A33',
        accentColor: '#0E5C61', borderColor: '#C9C0AE', headerBackgroundColor: '#EAE4D8',
        fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 13, spacing: 6, borderRadius: 8 }),
      columnDefs, rowData: [], defaultColDef: { sortable: true, resizable: true, width: 125,
        cellClass: 'grid-number', headerClass: 'grid-number-header', filter: true },
      getRowId: p => String(p.data.ward), rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
      onRowClicked: e => { if (e.data) select(e.data.ward); },
      onCellKeyDown: e => { if ((e.event as KeyboardEvent)?.key === 'Enter' && e.data) select(e.data.ward); },
      onModelUpdated: e => e.api.refreshCells({ columns: ['plan'], force: true }),
      rowHeight: 36, headerHeight: 42, tooltipShowDelay: 200,
    });
  }
  update(rows: GridRow[]) {
    this.rows = rows; this.api.setGridOption('rowData', rows); this.updateChart();
  }
  select(id: number, reveal = true) {
    const row = this.api.getRowNode(String(id));
    if (row) { row.setSelected(true, true); if (reveal) this.api.ensureNodeVisible(row, 'middle'); }
  }
  filter(value: string) { this.api.setGridOption('quickFilterText', value); }
  updateChart() {
    if (!this.chartHost.getBoundingClientRect().width) return;
    const options: AgChartOptions = {
      container: this.chartHost, data: this.rows.filter(r => r.plan > 0).sort((a, b) => a.ward - b.ward)
        .map(r => ({ ward: String(r.ward), dollars: r.plan })),
      background: { fill: '#F3EFE6' }, legend: { enabled: false },
      padding: { top: 12, right: 16, bottom: 12, left: 8 },
      theme: { palette: { fills: ['#0E5C61'], strokes: ['#0E5C61'] }, overrides: { common: {
        title: { fontFamily: 'Fraunces', color: '#1E2A33' }, axes: {
          category: { label: { fontFamily: 'IBM Plex Mono', color: '#1E2A33' } },
          number: { label: { fontFamily: 'IBM Plex Mono', color: '#1E2A33', fontSize: 10 } },
        },
      } } },
      series: [{ type: 'bar', xKey: 'ward', yKey: 'dollars', yName: 'Plan $', cornerRadius: 3,
        tooltip: { renderer: p => ({ title: `Ward ${p.datum.ward}`, content: dollars(p.datum.dollars) }) } }],
      axes: [{ type: 'category', position: 'bottom', title: { text: 'Ward' } },
        { type: 'number', position: 'left', label: { formatter: p => '$' + integer(Number(p.value)) } }],
    };
    if (this.chart) void this.chart.update(options); else this.chart = AgCharts.create(options);
  }
  destroy() { this.api.destroy(); this.chart?.destroy(); }
}
