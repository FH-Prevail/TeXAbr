import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { parseLatexStructure, StructureNode, ParseResult } from '../utils/latexStructureParser';
import '../styles/StructureMap.css';

interface StructureMapProps {
  content: string;
  currentFileExtension: string | null;
  onNodeClick?: (lineNumber: number) => void;
}

const StructureMap: React.FC<StructureMapProps> = ({ content, currentFileExtension, onNodeClick }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>('horizontal');

  useEffect(() => {
    // Only parse if it's a .tex file
    if (!currentFileExtension || (currentFileExtension !== 'tex' && currentFileExtension !== 'latex')) {
      setParseResult({
        isValid: false,
        structure: null,
        error: 'Structure Map is only available for LaTeX (.tex) files'
      });
      return;
    }

    const result = parseLatexStructure(content);
    setParseResult(result);
  }, [content, currentFileExtension]);

  useEffect(() => {
    if (!parseResult?.isValid || !parseResult.structure || !svgRef.current || !containerRef.current) {
      return;
    }

    // Clear previous content
    d3.select(svgRef.current).selectAll('*').remove();

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Create SVG
    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height);

    // Create a group for zoom/pan
    const g = svg.append('g');

    // Add zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoom);

    // Create hierarchy
    const root = d3.hierarchy(parseResult.structure);

    // Create tree layout based on orientation
    const treeLayout = d3.tree<StructureNode>()
      .size(orientation === 'vertical' ? [width - 100, height - 100] : [height - 100, width - 100])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.5));

    treeLayout(root);

    // Center the tree
    const offsetX = 50;
    const offsetY = 50;

    // Draw links based on orientation
    if (orientation === 'vertical') {
      g.selectAll('.link')
        .data(root.links())
        .enter()
        .append('path')
        .attr('class', 'link')
        .attr('d', d3.linkVertical<any, any>()
          .x(d => (d.x ?? 0) + offsetX)
          .y(d => (d.y ?? 0) + offsetY)
        )
        .attr('fill', 'none')
        .attr('stroke', '#4ec9b0')
        .attr('stroke-width', 2)
        .attr('stroke-opacity', 0.6);
    } else {
      g.selectAll('.link')
        .data(root.links())
        .enter()
        .append('path')
        .attr('class', 'link')
        .attr('d', d3.linkHorizontal<any, any>()
          .x(d => (d.y ?? 0) + offsetX)
          .y(d => (d.x ?? 0) + offsetY)
        )
        .attr('fill', 'none')
        .attr('stroke', '#4ec9b0')
        .attr('stroke-width', 2)
        .attr('stroke-opacity', 0.6);
    }

    // Draw nodes based on orientation
    const nodes = g.selectAll('.node')
      .data(root.descendants())
      .enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', d =>
        orientation === 'vertical'
          ? `translate(${(d.x ?? 0) + offsetX},${(d.y ?? 0) + offsetY})`
          : `translate(${(d.y ?? 0) + offsetX},${(d.x ?? 0) + offsetY})`
      );

    // Add circles
    const circles = nodes.append('circle')
      .attr('r', d => {
        // Size based on level
        switch (d.data.type) {
          case 'title': return 12;
          case 'chapter': return 10;
          case 'section': return 8;
          case 'subsection': return 6;
          case 'subsubsection': return 5;
          default: return 6;
        }
      })
      .attr('fill', d => {
        // Color based on type
        switch (d.data.type) {
          case 'title': return '#4ec9b0';
          case 'chapter': return '#569cd6';
          case 'section': return '#9cdcfe';
          case 'subsection': return '#ce9178';
          case 'subsubsection': return '#dcdcaa';
          default: return '#d4d4d4';
        }
      })
      .attr('stroke', 'var(--color-border-strong)')
      .attr('stroke-width', 2)
      .style('cursor', 'pointer');

    // Add hover effects
    nodes
      .on('mouseenter', function(event, d) {
        // Highlight the node
        d3.select(this).select('circle')
          .transition()
          .duration(200)
          .attr('r', function() {
            const currentRadius = parseFloat(d3.select(this).attr('r'));
            return currentRadius * 1.5;
          })
          .attr('stroke-width', 4);

        // Highlight the label
        d3.select(this).select('text')
          .transition()
          .duration(200)
          .attr('font-weight', 'bold')
          .style('font-size', function() {
            const currentSize = d3.select(this).attr('font-size');
            return `calc(${currentSize} * 1.2)`;
          });
      })
      .on('mouseleave', function(event, d) {
        // Restore node
        d3.select(this).select('circle')
          .transition()
          .duration(200)
          .attr('r', function() {
            switch (d.data.type) {
              case 'title': return 12;
              case 'chapter': return 10;
              case 'section': return 8;
              case 'subsection': return 6;
              case 'subsubsection': return 5;
              default: return 6;
            }
          })
          .attr('stroke-width', 2);

        // Restore label
        d3.select(this).select('text')
          .transition()
          .duration(200)
          .attr('font-weight', d.data.type === 'title' ? 'bold' : 'normal')
          .style('font-size', function() {
            switch (d.data.type) {
              case 'title': return '14px';
              case 'chapter': return '12px';
              case 'section': return '11px';
              default: return '10px';
            }
          });
      })
      .on('click', function(event, d) {
        // Jump to line in editor
        if (onNodeClick && d.data.lineNumber) {
          onNodeClick(d.data.lineNumber);
        }
      });

    // Add text labels based on orientation
    nodes.append('text')
      .attr('dy', orientation === 'vertical' ? -15 : 0)
      .attr('dx', orientation === 'horizontal' ? 15 : 0)
      .attr('text-anchor', orientation === 'vertical' ? 'start' : 'start')
      .attr('class', 'node-label')
      .attr('transform', orientation === 'vertical' ? 'rotate(-45)' : '')
      .text(d => {
        const maxLength = 30;
        return d.data.title.length > maxLength
          ? d.data.title.substring(0, maxLength) + '...'
          : d.data.title;
      })
      .attr('fill', 'var(--color-text-primary)')
      .attr('font-size', d => {
        switch (d.data.type) {
          case 'title': return '14px';
          case 'chapter': return '12px';
          case 'section': return '11px';
          default: return '10px';
        }
      })
      .attr('font-weight', d => d.data.type === 'title' ? 'bold' : 'normal');

    // Add tooltips
    nodes.append('title')
      .text(d => `${d.data.type}: ${d.data.title}\nLine: ${d.data.lineNumber}`);

    // Reset zoom to show all content
    const bounds = (g.node() as SVGGElement).getBBox();
    const fullWidth = bounds.width;
    const fullHeight = bounds.height;
    const midX = bounds.x + fullWidth / 2;
    const midY = bounds.y + fullHeight / 2;

    if (fullWidth > 0 && fullHeight > 0) {
      const scale = 0.9 / Math.max(fullWidth / width, fullHeight / height);
      const translate = [width / 2 - scale * midX, height / 2 - scale * midY];

      svg.transition()
        .duration(750)
        .call(zoom.transform as any, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
    }

  }, [parseResult, orientation]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (parseResult?.isValid) {
        setParseResult({ ...parseResult });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [parseResult]);

  if (!parseResult) {
    return (
      <div className="structure-map-container">
        <div className="structure-map-message">
          <p>Loading structure...</p>
        </div>
      </div>
    );
  }

  if (!parseResult.isValid) {
    return (
      <div className="structure-map-container">
        <div className="structure-map-error">
          <h3>Cannot Display Structure</h3>
          <p>{parseResult.error}</p>
          {currentFileExtension !== 'tex' && currentFileExtension !== 'latex' && (
            <p className="hint">Structure Map is only available for LaTeX (.tex) files.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="structure-map-container" ref={containerRef}>
      <div className="structure-map-header">
        <h3>Document Structure</h3>
        <div className="structure-map-controls">
          <div className="orientation-toggle">
            <button
              className={`orientation-btn ${orientation === 'vertical' ? 'active' : ''}`}
              onClick={() => setOrientation('vertical')}
              title="Vertical layout (top to bottom)"
            >
              Vertical
            </button>
            <button
              className={`orientation-btn ${orientation === 'horizontal' ? 'active' : ''}`}
              onClick={() => setOrientation('horizontal')}
              title="Horizontal layout (left to right)"
            >
              Horizontal
            </button>
          </div>
        </div>
        <div className="structure-map-legend">
          <div className="legend-item">
            <div className="legend-color" style={{ backgroundColor: '#4ec9b0' }}></div>
            <span>Title/Document</span>
          </div>
          <div className="legend-item">
            <div className="legend-color" style={{ backgroundColor: '#569cd6' }}></div>
            <span>Chapter</span>
          </div>
          <div className="legend-item">
            <div className="legend-color" style={{ backgroundColor: '#9cdcfe' }}></div>
            <span>Section</span>
          </div>
          <div className="legend-item">
            <div className="legend-color" style={{ backgroundColor: '#ce9178' }}></div>
            <span>Subsection</span>
          </div>
        </div>
        <p className="structure-hint">Scroll to zoom • Drag to pan • Click nodes to jump to section</p>
      </div>
      <svg ref={svgRef} className="structure-map-svg"></svg>
    </div>
  );
};

export default StructureMap;
