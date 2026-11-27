import { Module } from '@nestjs/common';
import { InspirationsModule } from '../inspirations/inspirations.module';
import { McpModule } from '../mcp/mcp.module';
import { FigmaController } from './figma.controller';
import { FigmaImageService } from './figma-image.service';
import { FigmaPairingService } from './figma-pairing.service';

/**
 * "Motvin — Inspiration", the Figma plugin's API at /api/figma/*.
 *
 * Built on the MCP module: the plugin signs in as an MCP connection, searches
 * with the same LibrarySearchService and shares the person's rate limits.
 *
 * - FigmaController      sign-in pairing, search, flows, images
 * - FigmaPairingService  hands the plugin its tokens after approval on motvin.com
 * - FigmaImageService    screens as JPEG parts Figma accepts
 */
@Module({
  imports: [InspirationsModule, McpModule],
  controllers: [FigmaController],
  providers: [FigmaPairingService, FigmaImageService],
})
export class FigmaModule {}
